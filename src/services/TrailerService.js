/**
 * TrailerService - YouTube-only trailer pipeline.
 *
 * Architecture:
 *   - Trailer là nested OBJECT trong Movie document. KHÔNG có Trailer collection.
 *   - Dùng nguyên schema `Movie.trailer` (KHÔNG đổi schema).
 *
 * ⭐ NGUYÊN TẮC CỐT LÕI — NGUỒN TRAILER DUY NHẤT (yêu cầu #1):
 *   Trailer CHỈ được lấy từ YouTube Data API v3 (`search.list`).
 *   KHÔNG còn fallback nào khác — đặc biệt KHÔNG dùng TMDB.
 *
 * ⭐ SEMANTICS:
 *   - Movie đã có `trailer.key` hợp lệ → giữ nguyên, KHÔNG search, KHÔNG ghi đè.
 *   - YouTube tìm được trailer → lưu thẳng vào `Movie.trailer` (OBJECT).
 *   - YouTube không có trailer (NOT_FOUND) → `trailer = null` + log
 *     `[Trailer] ⚠️ No trailer found`, KHÔNG fail việc tạo Movie.
 *   - YouTube bị rate limit / quota exceeded / circuit open → `trailer = null`
 *     + `trailerJobStatus='RATE_LIMITED'` + log
 *     `[Trailer] ⚠️ YouTube unavailable → trailer=null, retry later`.
 *   - Mọi lỗi (429 / 503 / network) đều KHÔNG crash pipeline.
 *
 * Status trả về bởi getTrailer():
 *   'FOUND'        → trailer lưu thành công (từ YouTube)
 *   'NOT_FOUND'    → đã search hết query, thật sự không có trailer
 *   'RATE_LIMITED' → YouTube đang bị chặn → retry sau cooldown
 *   'ERROR'        → lỗi không xác định → retry sau
 *   'SKIPPED'      → dedupe / in-flight / cooldown
 */

const YouTubeService = require('./YouTubeService');
const rateLimiter = require('../utils/youtubeRateLimiter');
const trailerState = require('../utils/trailerState');
const { Movie } = require('../models');
const logger = require('../utils/logger');

// Default cooldown nếu không có Retry-After (15 phút).
const DEFAULT_RETRY_AFTER_MS = 15 * 60 * 1000;

class TrailerService {
  /**
   * Thời gian còn lại của circuit breaker YouTube (ms). 0 nếu circuit không OPEN.
   * @private
   */
  _circuitRemainingMs() {
    try {
      if (!rateLimiter.isCircuitOpen()) return 0;
      return Math.max(0, rateLimiter.cb.cooldownMs - (Date.now() - rateLimiter.cb.openedAt));
    } catch (_) {
      return DEFAULT_RETRY_AFTER_MS;
    }
  }

  /**
   * Lấy year từ releaseDate (schema không lưu `year`).
   * @private
   */
  _yearOf(movie) {
    if (movie?.year) return movie.year;
    const rd = movie?.releaseDate;
    if (rd) {
      const d = rd instanceof Date ? rd : new Date(rd);
      if (!Number.isNaN(d.getTime())) return d.getUTCFullYear();
    }
    return null;
  }

  /**
   * Search YouTube cho trailer (NGUỒN DUY NHẤT).
   *
   * @param {Object} movie
   * @returns {Promise<{trailer:Object|null, status:string, retryAt:Date|null, error:Error|null, source:string|null}>}
   *   status: 'FOUND' | 'NOT_FOUND' | 'RATE_LIMITED' | 'ERROR'
   */
  async search(movie) {
    if (!movie || !movie.name) {
      return { trailer: null, status: 'NOT_FOUND', retryAt: null, error: null, source: null };
    }

    // Pre-check: circuit OPEN hoặc service disabled → KHÔNG gọi mạng YouTube.
    // Trả RATE_LIMITED ngay để caller biết cần retry sau (yêu cầu #6).
    if (!YouTubeService.isAvailable()) {
      const circuitOpen = rateLimiter.isCircuitOpen();
      const retryAfterMs = circuitOpen
        ? Math.max(1000, this._circuitRemainingMs())
        : DEFAULT_RETRY_AFTER_MS;

      // ⭐ Yêu cầu #6: log message chuẩn, KHÔNG gọi TMDB.
      logger.warn(
        `[Trailer] ⚠️ YouTube unavailable → trailer=null, retry later ` +
        `(reason=${circuitOpen ? 'CIRCUIT_OPEN' : 'DISABLED'}, ` +
        `~${Math.round(retryAfterMs / 1000)}s) for "${movie.name}"`
      );
      return {
        trailer: null,
        status: 'RATE_LIMITED',
        retryAt: new Date(Date.now() + retryAfterMs),
        error: null,
        source: null,
      };
    }

    try {
      const result = await YouTubeService.searchTrailer(
        movie.name,
        this._yearOf(movie),
        movie.originName
      );
      if (result && result.key) {
        return {
          trailer: {
            name: result.name,
            key: result.key,
            site: 'YouTube',
            type: result.type || 'Trailer',
            official: result.official ?? false,
            publishedAt: result.publishedAt ?? null,
            url: result.url || `https://www.youtube.com/watch?v=${result.key}`,
            updatedAt: new Date(),
            viewCount: result.viewCount ?? 0,
          },
          status: 'FOUND',
          retryAt: null,
          error: null,
          source: 'youtube',
        };
      }
      // null + không throw = đã thử hết query, thật sự không có trailer
      return { trailer: null, status: 'NOT_FOUND', retryAt: null, error: null, source: null };
    } catch (err) {
      // YouTube bị chặn tạm thời (429 / circuit open / quota) → KHÔNG coi là NOT_FOUND
      if (err.code === 'RATE_LIMITED' || err.code === 'CIRCUIT_OPEN' || err.code === 'QUOTA_EXCEEDED') {
        const retryAfterMs = err.retryAfterMs || DEFAULT_RETRY_AFTER_MS;
        // ⭐ Yêu cầu #6: log message chuẩn, KHÔNG gọi TMDB.
        logger.warn(
          `[Trailer] ⚠️ YouTube unavailable → trailer=null, retry later ` +
          `(code=${err.code}, ~${Math.round(retryAfterMs / 1000)}s) for "${movie.name}"`
        );
        return {
          trailer: null,
          status: 'RATE_LIMITED',
          retryAt: new Date(Date.now() + retryAfterMs),
          error: err,
          source: null,
        };
      }
      // Generic error (network / 5xx) → log, KHÔNG crash
      logger.warn(`[Trailer] ⚠️ YouTube search error for "${movie.name}": ${err.message}`);
      return { trailer: null, status: 'ERROR', retryAt: null, error: err, source: null };
    }
  }

  /**
   * ⭐ MAIN ENTRY: xử lý trailer cho 1 movie (lock + cooldown + dedupe).
   *
   * GUARANTEES:
   *   - Lock per movie  → cùng 1 movie KHÔNG chạy 2 lần đồng thời
   *   - retryAt         → now < retryAt thì SKIP, KHÔNG gọi mạng
   *   - dedupe window   → không xử lại movie vừa xử lý trong N ms
   *   - trailer hợp lệ  → giữ nguyên, KHÔNG bao giờ ghi null
   *
   * @param {Object} movie
   * @param {Object} [opts]
   * @param {boolean} [opts.force=false] Bỏ qua dedupe window (admin/manual)
   * @param {boolean} [opts.skipCooldown=false] Bỏ qua cooldown
   * @returns {Promise<{trailer, status, saved, retryAt, source, skipped?}>}
   */
  async getTrailer(movie, opts = {}) {
    if (!movie) {
      return { trailer: null, status: 'SKIPPED', saved: false, retryAt: null, source: null, skipped: true };
    }

    const force = !!opts.force;
    const skipCooldown = !!opts.skipCooldown;
    const key = String(movie._id || movie.slug || movie.name || '');

    // ─────────────────────────────────────────────────────────────────
    // GUARD 0: ĐÃ CÓ TRAILER HỢP LỆ → giữ nguyên, KHÔNG search, KHÔNG ghi đè
    // ─────────────────────────────────────────────────────────────────
    if (movie.trailer && movie.trailer.key) {
      logger.debug(
        `[Trailer] ♻️ Keeping existing trailer for "${movie.name}" (key=${movie.trailer.key})`
      );
      return {
        trailer: movie.trailer,
        status: 'FOUND',
        saved: false,
        retryAt: null,
        source: 'existing',
        skipped: true,
      };
    }

    // ─────────────────────────────────────────────────────────────────
    // GUARD 1: DEDUPE WINDOW — movie vừa xử lý → skip
    // ─────────────────────────────────────────────────────────────────
    if (!force && trailerState.isRecentlyProcessed(key)) {
      const remaining = Math.round(trailerState.dedupeRemainingMs(key) / 1000);
      logger.debug(
        `[Trailer] ⏭ SKIP "${movie.name}" — deduped (processed <${remaining}s ago)`
      );
      return {
        trailer: null,
        status: 'SKIPPED',
        saved: false,
        retryAt: trailerState.getCooldown(key)?.retryAt || null,
        source: null,
        skipped: true,
      };
    }

    // ─────────────────────────────────────────────────────────────────
    // GUARD 2: RETRY-AT COOLDOWN — now < retryAt → skip
    // ─────────────────────────────────────────────────────────────────
    if (!skipCooldown) {
      const cd = trailerState.shouldSkipForCooldown(key);
      if (cd.skip) {
        const remaining = Math.round(cd.remainingMs / 1000);
        logger.info(
          `[Trailer] ⏭ SKIP "${movie.name}" — retry scheduled ` +
          `(status=${cd.reason}, retryAt=${cd.retryAt?.toISOString()}, ~${remaining}s remaining)`
        );
        return {
          trailer: null,
          status: 'SKIPPED',
          saved: false,
          retryAt: cd.retryAt,
          source: null,
          skipped: true,
          skipReason: cd.reason,
        };
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // GUARD 3: IN-FLIGHT LOCK — cùng movie không chạy 2 lần đồng thời
    // ─────────────────────────────────────────────────────────────────
    if (!trailerState.acquire(key)) {
      logger.debug(
        `[Trailer] 🔒 SKIP "${movie.name}" — already in-flight (another process holds the lock)`
      );
      return {
        trailer: null,
        status: 'SKIPPED',
        saved: false,
        retryAt: null,
        source: null,
        skipped: true,
        skipReason: 'IN_FLIGHT',
      };
    }

    // Từ đây trở đi: đã giữ lock → BẮT BUỘC release trong finally
    try {
      trailerState.markProcessed(key);
      return await this._processTrailer(movie, key);
    } finally {
      trailerState.release(key);
    }
  }

  /**
   * Logic xử lý trailer thật sự (đã giữ lock + đã qua các guard).
   *
   * NGUYÊN TẮC (yêu cầu #1, #5, #6, #7):
   *   - CHỈ dùng YouTube. KHÔNG có fallback nào khác (đặc biệt không TMDB).
   *   - YouTube FOUND → lưu vào `Movie.trailer` + log "✅ YouTube trailer found"
   *     + log "💾 Trailer saved to Movie" TRƯỚC khi log "Created/Updated movie".
   *   - YouTube RATE_LIMITED (429 / QUOTA_EXCEEDED / CIRCUIT_OPEN) →
   *     trailer=null, retryAt set, KHÔNG fail movie.
   *   - YouTube NOT_FOUND (đã thử hết query) → trailer=null, log "⚠️ No trailer found".
   *   - KHÔNG BAO GIỜ log "ERROR resolving trailer ... Trailer untouched".
   *
   * @private
   */
  async _processTrailer(movie, key) {
    // ─────────────────────────────────────────────────────────────────
    // SOURCE 1 (DUY NHẤT): YouTube
    // ─────────────────────────────────────────────────────────────────
    const youtube = await this.search(movie);

    if (youtube.status === 'FOUND' && youtube.trailer) {
      // ⭐ Yêu cầu #7: lưu trailer vào MongoDB TRƯỚC, log "💾 Trailer saved to Movie"
      // TRƯỚC log "Created/Updated movie".
      const saved = await this.saveTrailer(movie._id, youtube.trailer);
      trailerState.clearCooldown(key);
      logger.info(
        `[Trailer] ✅ YouTube trailer found: ${youtube.trailer.key} ` +
        `("${youtube.trailer.name}") for "${movie.name}"`
      );
      logger.info(
        `[Trailer] 💾 Trailer saved to Movie ${movie._id || movie.slug} (key=${youtube.trailer.key})`
      );
      return {
        trailer: youtube.trailer,
        status: 'FOUND',
        saved,
        retryAt: null,
        source: 'youtube',
      };
    }

    // ─────────────────────────────────────────────────────────────────
    // YouTube RATE_LIMITED (429 / QUOTA_EXCEEDED / CIRCUIT_OPEN) →
    // trailer=null, retryAt set, KHÔNG gọi TMDB (đã log "⚠️ YouTube unavailable").
    // ─────────────────────────────────────────────────────────────────
    if (youtube.status === 'RATE_LIMITED') {
      const retryAt =
        youtube.retryAt || new Date(Date.now() + DEFAULT_RETRY_AFTER_MS);
      await this.markRateLimited(movie._id, retryAt);
      trailerState.setCooldown(key, retryAt, 'YOUTUBE_RATE_LIMITED');
      return { trailer: null, status: 'RATE_LIMITED', saved: false, retryAt, source: null };
    }

    // ─────────────────────────────────────────────────────────────────
    // YouTube lỗi (network / 5xx) → trailer=null, retry sau.
    // ─────────────────────────────────────────────────────────────────
    if (youtube.status === 'ERROR') {
      const retryAt = new Date(Date.now() + DEFAULT_RETRY_AFTER_MS);
      await this.markRateLimited(movie._id, retryAt);
      trailerState.setCooldown(key, retryAt, 'ERROR');
      logger.warn(
        `[Trailer] ⚠️ Trailer source error for "${movie.name}" ` +
        `(youtube=ERROR) — retryAt=${retryAt.toISOString()}. ` +
        `Trailer remains null and will be retried.`
      );
      return { trailer: null, status: 'ERROR', saved: false, retryAt, source: null };
    }

    // ─────────────────────────────────────────────────────────────────
    // YouTube thật sự không có trailer (NOT_FOUND) → trailer=null,
    // KHÔNG fail movie. KHÔNG có fallback nào khác (yêu cầu #1, #6).
    // ─────────────────────────────────────────────────────────────────
    await this.markNotFound(movie._id);
    trailerState.clearCooldown(key);
    logger.warn(
      `[Trailer] ⚠️ No trailer found for "${movie.name}" ` +
      `(youtube=${youtube.status}) → trailer = null`
    );
    return { trailer: null, status: 'NOT_FOUND', saved: false, retryAt: null, source: null };
  }

  /**
   * Lưu trailer thật (có key) vào `Movie.trailer` dưới dạng OBJECT.
   *
   * SAFETY: KHÔNG ghi đè một trailer hợp lệ đã tồn tại (race với batch job khác).
   * Nếu filter "chỉ ghi khi chưa có" không match, sẽ kiểm tra lại: nếu movie thật
   * sự chưa có trailer (do filter mismatch) → ghi thẳng để không bỏ sót.
   * KHÔNG BAO GIỜ set null.
   *
   * @returns {Promise<boolean>} true nếu đã ghi vào DB
   */
  async saveTrailer(movieId, trailer) {
    if (!trailer || !trailer.key) {
      logger.debug('[Trailer] saveTrailer skipped — no key provided');
      return false;
    }
    if (!movieId) {
      logger.warn('[Trailer] saveTrailer skipped — missing movieId');
      return false;
    }

    const url = trailer.url || `https://www.youtube.com/watch?v=${trailer.key}`;
    const doc = {
      name: trailer.name || '',
      key: trailer.key,
      site: trailer.site || 'YouTube',
      type: trailer.type || 'Trailer',
      official: !!trailer.official,
      publishedAt: trailer.publishedAt || null,
      url,
      updatedAt: trailer.updatedAt || new Date(),
      viewCount: trailer.viewCount ?? 0,
    };

    try {
      // Chỉ ghi khi movie chưa có trailer hợp lệ (tránh race với batch job khác)
      const result = await Movie.updateOne(
        {
          _id: movieId,
          $or: [
            { trailer: { $exists: false } },
            { trailer: null },
            { 'trailer.key': { $exists: false } },
            { 'trailer.key': null },
            { 'trailer.key': '' },
          ],
        },
        {
          $set: {
            trailer: doc,
            'tmdb.trailer_url': url,
            trailerJobStatus: 'OK',
            trailerRetryAt: null,
          },
        }
      );

      if (result.matchedCount > 0) {
        return true;
      }

      // matchedCount === 0 → kiểm tra movie đã có trailer hợp lệ chưa
      const existing = await Movie.findOne({ _id: movieId }).select('trailer').lean();
      if (existing?.trailer?.key) {
        logger.debug(
          `[Trailer] saveTrailer skipped for movie ${movieId} — existing valid trailer preserved`
        );
        return false;
      }

      // Movie thực sự chưa có trailer (filter mismatch) → ghi thẳng
      await Movie.updateOne(
        { _id: movieId },
        {
          $set: {
            trailer: doc,
            'tmdb.trailer_url': url,
            trailerJobStatus: 'OK',
            trailerRetryAt: null,
          },
        }
      );
      return true;
    } catch (error) {
      logger.error(`[Trailer] Failed to save trailer: ${error.message}`);
      return false;
    }
  }

  /** Đánh dấu job bị rate-limited; trailer giữ nguyên (null hoặc bản cũ). */
  async markRateLimited(movieId, retryAt) {
    try {
      await Movie.updateOne(
        { _id: movieId },
        {
          $set: {
            trailerJobStatus: 'RATE_LIMITED',
            trailerRetryAt: retryAt || new Date(Date.now() + DEFAULT_RETRY_AFTER_MS),
          },
        }
      );
    } catch (error) {
      logger.error(`[Trailer] Failed to mark RATE_LIMITED: ${error.message}`);
    }
  }

  /**
   * Đánh dấu NOT_FOUND; trailer giữ nguyên (null).
   * CHỈ gọi khi đã search hết query YouTube và không có kết quả.
   */
  async markNotFound(movieId) {
    try {
      await Movie.updateOne(
        { _id: movieId },
        { $set: { trailerJobStatus: 'NOT_FOUND', trailerRetryAt: null } }
      );
    } catch (error) {
      logger.error(`[Trailer] Failed to mark NOT_FOUND: ${error.message}`);
    }
  }

  /**
   * Fetch + update trailer cho 1 movie theo slug (admin endpoint).
   * Dùng `force: true` vì đây là yêu cầu tường minh — bỏ qua dedupe window.
   */
  async fetchAndUpdateTrailer(slug) {
    try {
      const movie = await Movie.findOne({ slug });
      if (!movie) {
        return { success: false, message: `Movie not found: ${slug}` };
      }

      const result = await this.getTrailer(movie, { force: true });
      return {
        success: result.status === 'FOUND',
        message:
          result.status === 'FOUND'
            ? `Trailer saved for: ${movie.name} (source=${result.source})`
            : result.status === 'SKIPPED'
              ? `Skipped: ${movie.name} (${result.skipReason || 'dedupe/in-flight'})`
              : `No trailer (status=${result.status}) for: ${movie.name}`,
        trailer: result.trailer,
        status: result.status,
        source: result.source,
      };
    } catch (error) {
      logger.error(`[Trailer] fetchAndUpdateTrailer failed for ${slug}: ${error.message}`);
      return { success: false, message: error.message, trailer: null };
    }
  }

  /**
   * Batch retry trailers cho movies chưa có trailer (hoặc RATE_LIMITED đã hết hạn).
   *
   *   - Deduplicate theo _id
   *   - Tôn trọng `trailerRetryAt` từ DB
   *   - YouTube circuit OPEN → defer toàn bộ batch (chờ cooldown)
   */
  async batchUpdateTrailers(limit = 50) {
    logger.info(`[Trailer] Starting batch update (limit: ${limit})`);

    // Dọn state cũ để tránh rò rỉ bộ nhớ
    trailerState.prune();

    // YouTube circuit đang OPEN → defer toàn bộ batch
    if (rateLimiter.isCircuitOpen()) {
      const remaining = Math.round(this._circuitRemainingMs() / 1000);
      logger.warn(
        `[Trailer] ⏭ YouTube circuit OPEN — batch deferred ` +
        `(~${remaining}s remaining).`
      );
      return {
        total: 0, found: 0, rateLimited: 0, notFound: 0,
        errors: 0, skipped: 0, deferred: true,
      };
    }

    const now = new Date();
    const movies = await Movie.find({
      $or: [
        { trailer: null },
        { trailer: { $exists: false } },
        { 'trailer.key': { $exists: false } },
        { 'trailer.key': '' },
        { trailerJobStatus: 'RATE_LIMITED', trailerRetryAt: { $lte: now } },
      ],
    })
      .select('_id name year releaseDate originName trailer trailerJobStatus trailerRetryAt')
      .limit(limit)
      .lean();

    // Deduplicate theo _id
    const seen = new Set();
    const unique = [];
    for (const m of movies) {
      const id = String(m._id);
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(m);
    }

    logger.info(
      `[Trailer] Found ${movies.length} movies (${unique.length} unique after dedupe)`
    );

    let found = 0, rateLimited = 0, notFound = 0, errors = 0, skipped = 0;

    for (const m of unique) {
      // YouTube hết cooldown nhưng lại vừa bị chặn lại → dừng batch
      if (rateLimiter.isCircuitOpen()) {
        logger.warn(
          `[Trailer] ⏭ YouTube circuit OPEN — stopping batch at ` +
          `${skipped + found + rateLimited + notFound + errors}/${unique.length}. Remaining deferred.`
        );
        skipped += unique.length - (skipped + found + rateLimited + notFound + errors);
        break;
      }

      // Tôn trọng retryAt từ DB
      if (
        m.trailerJobStatus === 'RATE_LIMITED' &&
        m.trailerRetryAt &&
        new Date(m.trailerRetryAt).getTime() > Date.now()
      ) {
        skipped++;
        logger.info(
          `[Trailer] ⏭ SKIP "${m.name}" — retry scheduled ` +
          `(retryAt=${new Date(m.trailerRetryAt).toISOString()})`
        );
        continue;
      }

      try {
        const result = await this.getTrailer(m);

        if (result.status === 'FOUND') {
          found++;
        } else if (result.status === 'RATE_LIMITED') {
          rateLimited++;
          logger.info(
            `[Trailer] ⏸ RATE_LIMITED for "${m.name}" — ` +
            `retryAt=${result.retryAt?.toISOString()}, moving to next movie`
          );
        } else if (result.status === 'NOT_FOUND') {
          notFound++;
        } else if (result.status === 'SKIPPED') {
          skipped++;
        } else {
          errors++;
        }
      } catch (err) {
        errors++;
        logger.warn(`[Trailer] Batch failed for ${m.name}: ${err.message}`);
      }
    }

    const stats = {
      total: unique.length,
      found,
      rateLimited,
      notFound,
      errors,
      skipped,
    };
    logger.info(`[Trailer] Batch update complete: ${JSON.stringify(stats)}`);
    return stats;
  }

  /** Count movies có trailer thật (key non-empty). */
  async countWithTrailer() {
    return Movie.countDocuments({ 'trailer.key': { $exists: true, $ne: '' } });
  }

  /** Thống kê tổng quan trailer để debug. */
  async getStats() {
    const [withTrailer, total, rateLimited, notFound] = await Promise.all([
      this.countWithTrailer(),
      Movie.countDocuments({}),
      Movie.countDocuments({ trailerJobStatus: 'RATE_LIMITED' }),
      Movie.countDocuments({ trailerJobStatus: 'NOT_FOUND' }),
    ]);
    return {
      total,
      withTrailer,
      withoutTrailer: total - withTrailer,
      coverage: total > 0 ? ((withTrailer / total) * 100).toFixed(2) + '%' : '0%',
      rateLimited,
      notFound,
      youtube: {
        enabled: YouTubeService.enabled,
        available: YouTubeService.isAvailable(),
        circuitOpen: rateLimiter.isCircuitOpen(),
        circuitRemainingMs: this._circuitRemainingMs(),
      },
      state: trailerState.stats(),
    };
  }
}

module.exports = new TrailerService();
