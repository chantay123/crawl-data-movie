/**
 * Trailer Checkpoint Utility - Persistent checkpoint manager for trailer crawler.
 *
 * Mục đích:
 *   - Load/save checkpoint vào MongoDB.
 *   - Persistent (server restart-safe).
 *   - Resume từ đúng vị trí đã dừng.
 *
 * Lifecycle:
 *   1. start(jobId)           → tạo/load checkpoint, return resume info
 *   2. beforeMovie(checkpoint, movie, index) → cập nhật currentMovieId/currentIndex
 *   3. afterMovie(checkpoint, movie, index) → cập nhật lastProcessed*
 *   4. quotaExceeded(checkpoint, movie, index, resetAt) → set status=QUOTA_EXCEEDED
 *   5. complete(checkpoint)   → set status=COMPLETED, currentIndex=totalMovies
 *   6. pause(checkpoint)      → set status=PAUSED
 */

const { TrailerCrawlerCheckpoint } = require('../models');
const logger = require('./logger');

class TrailerCheckpoint {
  /**
   * Tạo hoặc load checkpoint cho 1 job.
   *
   * @param {string} jobId
   * @param {Object} [opts]
   * @param {number} [opts.totalMovies=0]   Tổng số movie dự kiến
   * @param {number} [opts.batchSize=10]
   * @param {number} [opts.maxMovies=0]
   * @param {boolean} [opts.forceRestart=false]  Bỏ qua checkpoint cũ, start lại từ đầu
   * @returns {Promise<Object|null>} Checkpoint document hoặc null nếu totalMovies=0
   */
  async start(jobId, opts = {}) {
    const {
      totalMovies = 0,
      batchSize = 10,
      maxMovies = 0,
      forceRestart = false,
    } = opts;

    if (!jobId) {
      throw new Error('[TrailerCheckpoint] jobId is required');
    }

    let cp = null;

    if (!forceRestart) {
      // Tìm checkpoint resumable (RUNNING/QUOTA_EXCEEDED/PAUSED)
      cp = await TrailerCrawlerCheckpoint.findResumable(jobId);
    }

    if (cp) {
      logger.info(
        `[Crawler] ▶ START: Resuming checkpoint jobId=${jobId} ` +
        `status=${cp.status} from index=${cp.currentIndex}/${cp.totalMovies} ` +
        `(lastProcessed=${cp.lastProcessedIndex}, updatedAt=${cp.updatedAt?.toISOString?.() || cp.updatedAt})`
      );
      // Cập nhật status từ QUOTA_EXCEEDED/PAUSED → RUNNING
      if (cp.status !== 'RUNNING') {
        cp = await TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
          status: 'RUNNING',
          // KHÔNG reset currentIndex/currentMovieId — giữ nguyên vị trí đã dừng
        });
      }
      return cp;
    }

    // Tạo checkpoint mới
    cp = await TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'RUNNING',
      currentMovieId: null,
      currentIndex: 0,
      totalMovies,
      lastProcessedMovieId: null,
      lastProcessedIndex: -1,
      quotaExceededAt: null,
      resumeAt: null,
      config: { batchSize, maxMovies },
      stats: { found: 0, notFound: 0, rateLimited: 0, errors: 0, skipped: 0 },
    });

    logger.info(
      `[Crawler] ▶ START: New checkpoint jobId=${jobId} ` +
      `totalMovies=${totalMovies} batchSize=${batchSize} maxMovies=${maxMovies}`
    );
    return cp;
  }

  /**
   * Cập nhật checkpoint TRƯỚC khi xử lý 1 movie.
   * Lưu currentMovieId và currentIndex.
   *
   * @param {string} jobId
   * @param {Object} movie
   * @param {number} index  0-based index trong pool
   */
  async beforeMovie(jobId, movie, index) {
    return TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'RUNNING',
      currentMovieId: movie._id,
      currentIndex: index,
    });
  }

  /**
   * Cập nhật checkpoint SAU khi xử lý 1 movie.
   * Lưu lastProcessedMovieId và lastProcessedIndex.
   *
   * @param {string} jobId
   * @param {Object} movie
   * @param {number} index  0-based index trong pool
   * @param {string} status  Trạng thái của movie: 'FOUND' | 'NOT_FOUND' | 'SKIPPED'
   */
  async afterMovie(jobId, movie, index, status) {
    // ⭐ QUAN TRỌNG: SAU khi xử lý xong 1 movie, currentIndex phải nhảy sang
    // movie TIẾP THEO (index + 1). Nếu không, khi crash xảy ra NGAY SAU
    // lastProcessed, lần sau sẽ xử lý lại movie đó.
    //
    // Nhưng nếu gặp QUOTA_EXCEEDED giữa chừng, currentIndex vẫn ở movie đó
    // → cần set trong quotaExceeded() riêng.
    const update = {
      $set: {
        lastProcessedMovieId: movie._id,
        lastProcessedIndex: index,
        currentIndex: index + 1,
        currentMovieId: null,
      },
      $inc: {},
    };

    if (status === 'FOUND') update.$inc['stats.found'] = 1;
    else if (status === 'NOT_FOUND') update.$inc['stats.notFound'] = 1;
    else if (status === 'SKIPPED') update.$inc['stats.skipped'] = 1;

    return TrailerCrawlerCheckpoint.findOneAndUpdate(
      { jobId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
  }

  /**
   * ⭐ QUAN TRỌNG (yêu cầu #4, #14):
   * Lưu checkpoint khi gặp QUOTA_EXCEEDED.
   * - currentMovieId = movie hiện tại (chưa xử lý xong)
   * - currentIndex = index của movie hiện tại (KHÔNG +1)
   * - lastProcessed = movie trước đó (KHÔNG thay đổi)
   * - status = 'QUOTA_EXCEEDED'
   * - quotaExceededAt, resumeAt
   *
   * → Lần sau chạy lại, crawler sẽ bắt đầu TỪ movie bị quota
   * (currentIndex = index của movie đó), thử lại movie đó trước,
   * sau khi thành công mới chuyển sang movie kế.
   *
   * @param {string} jobId
   * @param {Object} movie       Movie hiện tại bị QUOTA_EXCEEDED
   * @param {number} index       Index của movie đó trong pool
   * @param {Date|null} resumeAt Thời điểm quota reset
   */
  async quotaExceeded(jobId, movie, index, resumeAt = null) {
    const now = new Date();
    return TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'QUOTA_EXCEEDED',
      currentMovieId: movie._id,
      currentIndex: index, // ⭐ KHÔNG +1 — phải thử lại movie này trước
      quotaExceededAt: now,
      resumeAt: resumeAt || null,
    });
  }

  /**
   * Lưu khi batch bị pause (manual hoặc lỗi khác).
   */
  async pause(jobId, reason = 'PAUSED') {
    return TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'PAUSED',
    });
  }

  /**
   * Hoàn thành batch.
   */
  async complete(jobId, totalMovies, stats = {}) {
    return TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'COMPLETED',
      currentMovieId: null,
      currentIndex: totalMovies,
      lastProcessedIndex: totalMovies - 1,
      quotaExceededAt: null,
      resumeAt: null,
      stats,
    });
  }

  /**
   * Cập nhật stats (increment).
   */
  async incrementStat(jobId, field, amount = 1) {
    return TrailerCrawlerCheckpoint.findOneAndUpdate(
      { jobId },
      { $inc: { [`stats.${field}`]: amount } },
      { new: true }
    ).lean();
  }

  /**
   * Lấy checkpoint hiện tại (helper).
   */
  async get(jobId) {
    return TrailerCrawlerCheckpoint.findByJobId(jobId);
  }

  /**
   * Xóa checkpoint (admin/manual).
   */
  async clear(jobId) {
    return TrailerCrawlerCheckpoint.deleteOne({ jobId });
  }
}

module.exports = new TrailerCheckpoint();