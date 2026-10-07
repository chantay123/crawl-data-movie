/**
 * TrailerCrawlerCheckpoint Model - Persistent checkpoint for trailer crawler.
 *
 * Mục đích:
 *   - Lưu chính xác vị trí đang cào để resume khi:
 *     + Server restart
 *     + QUOTA_EXCEEDED
 *     + PAUSED
 *   - Persistent vào MongoDB, KHÔNG memory-only.
 *
 * Schema (yêu cầu #1):
 *   {
 *     jobId,         // unique identifier cho batch run
 *     status,        // 'RUNNING' | 'QUOTA_EXCEEDED' | 'PAUSED' | 'COMPLETED'
 *     currentMovieId,
 *     currentIndex,
 *     totalMovies,
 *     lastProcessedMovieId,
 *     lastProcessedIndex,
 *     quotaExceededAt,
 *     resumeAt,
 *     updatedAt
 *   }
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const trailerCrawlerCheckpointSchema = new Schema({
  // Job identifier (cho phép nhiều job song song nếu cần)
  jobId: {
    type: String,
    required: true,
    unique: true,
    maxlength: 100,
    index: true,
  },

  // Status
  status: {
    type: String,
    enum: ['RUNNING', 'QUOTA_EXCEEDED', 'PAUSED', 'COMPLETED'],
    required: true,
    default: 'RUNNING',
    index: true,
  },

  // Movie hiện tại đang xử lý (có thể chưa hoàn thành)
  currentMovieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    default: null,
  },
  currentIndex: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },

  // Tổng số movie trong batch
  totalMovies: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },

  // Movie cuối cùng đã xử lý XONG (FOUND hoặc NOT_FOUND)
  lastProcessedMovieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    default: null,
  },
  lastProcessedIndex: {
    type: Number,
    required: true,
    default: -1, // -1 = chưa xử lý movie nào
  },

  // Thời điểm quota bị exceeded
  quotaExceededAt: {
    type: Date,
    default: null,
  },

  // Thời điểm có thể resume (sau khi quota reset)
  resumeAt: {
    type: Date,
    default: null,
    index: true,
  },

  // Thống kê cho tiện debug
  stats: {
    type: new Schema({
      found: { type: Number, default: 0 },
      notFound: { type: Number, default: 0 },
      rateLimited: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    }, { _id: false }),
    default: null,
  },

  // Batched/limit config để dễ debug
  config: {
    type: new Schema({
      batchSize: { type: Number, default: 10 },
      maxMovies: { type: Number, default: 0 },
    }, { _id: false }),
    default: null,
  },
}, {
  timestamps: true,
});

// ============================================================
// INDEXES
// ============================================================

// Tìm checkpoint mới nhất đang RUNNING/QUOTA_EXCEEDED
trailerCrawlerCheckpointSchema.index(
  { jobId: 1, status: 1 },
  { name: 'idx_jobId_status' }
);

// Tìm checkpoint theo resumeAt (cho scheduler)
trailerCrawlerCheckpointSchema.index(
  { status: 1, resumeAt: 1 },
  { name: 'idx_status_resumeAt' }
);

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Tìm checkpoint mới nhất cho 1 jobId.
 */
trailerCrawlerCheckpointSchema.statics.findByJobId = function(jobId) {
  return this.findOne({ jobId }).sort({ updatedAt: -1 }).lean();
};

/**
 * Tìm checkpoint cuối cùng cần resume (QUOTA_EXCEEDED, PAUSED, hoặc RUNNING).
 */
trailerCrawlerCheckpointSchema.statics.findResumable = function(jobId) {
  return this.findOne({
    jobId,
    status: { $in: ['RUNNING', 'QUOTA_EXCEEDED', 'PAUSED'] },
  })
    .sort({ updatedAt: -1 })
    .lean();
};

/**
 * Upsert checkpoint (atomic).
 */
trailerCrawlerCheckpointSchema.statics.upsertCheckpoint = function(jobId, data) {
  return this.findOneAndUpdate(
    { jobId },
    { $set: { ...data, jobId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
};

const TrailerCrawlerCheckpoint =
  mongoose.models.TrailerCrawlerCheckpoint ||
  mongoose.model('TrailerCrawlerCheckpoint', trailerCrawlerCheckpointSchema);

module.exports = TrailerCrawlerCheckpoint;