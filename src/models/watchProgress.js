/**
 * Watch Progress Model - Optimized
 * Clean Architecture - MongoDB Best Practices
 * 
 * Tracks user's watch progress per movie.
 * One resume point per user/movie combination.
 * No episodeId - Movie is the main unit.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const watchProgressSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true,
    index: true
  },
  progressSeconds: {
    type: Number,
    default: 0,
    min: 0
  },
  durationSeconds: {
    type: Number,
    default: 0,
    min: 0
  },
  completed: {
    type: Boolean,
    default: false
  },
  lastWatchedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// ============================================================
// INDEXES
// ============================================================

// Unique compound index: one progress per user/movie
watchProgressSchema.index(
  { userId: 1, movieId: 1 },
  { unique: true, name: 'unique_user_movie_progress' }
);

// Compound index for continue watching list
watchProgressSchema.index(
  { userId: 1, lastWatchedAt: -1 },
  { name: 'idx_user_continue_watching' }
);

// Compound index for completed filtering
watchProgressSchema.index(
  { userId: 1, completed: 1, lastWatchedAt: -1 },
  { name: 'idx_user_completed' }
);

// ============================================================
// METHODS
// ============================================================

/**
 * Calculate progress percentage
 */
watchProgressSchema.methods.getProgressPercentage = function() {
  if (!this.durationSeconds || this.durationSeconds === 0) {
    return 0;
  }
  return Math.min(100, Math.round((this.progressSeconds / this.durationSeconds) * 100));
};

/**
 * Check if progress qualifies as completed (>90%)
 */
watchProgressSchema.methods.shouldMarkCompleted = function() {
  return this.durationSeconds > 0 && 
         this.progressSeconds >= this.durationSeconds * 0.9;
};

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Update or create watch progress
 */
watchProgressSchema.statics.upsertProgress = async function(userId, movieId, data) {
  const { progressSeconds = 0, durationSeconds = 0 } = data;
  
  // Determine if completed (90% watched)
  const completed = durationSeconds > 0 && progressSeconds >= durationSeconds * 0.9;
  
  const result = await this.findOneAndUpdate(
    { userId, movieId },
    {
      $set: {
        progressSeconds,
        durationSeconds,
        completed,
        lastWatchedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );
  
  return result;
};

/**
 * Get user's watch progress for a movie
 */
watchProgressSchema.statics.getProgress = async function(userId, movieId) {
  return this.findOne({ userId, movieId }).lean();
};

/**
 * Get user's continue watching list
 */
watchProgressSchema.statics.getContinueWatching = async function(userId, options = {}) {
  const { page = 1, limit = 24, includeCompleted = false } = options;
  const skip = (page - 1) * limit;

  const Movie = mongoose.model('Movie');

  const query = { userId };
  if (!includeCompleted) {
    query.completed = false;
  }

  const items = await this.find(query)
    .sort({ lastWatchedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  if (items.length === 0) {
    return { items: [], total: 0 };
  }

  const movieIds = items.map(item => item.movieId);
  const movies = await Movie.find({ 
    _id: { $in: movieIds },
    isPublished: true,
    isHidden: false
  }).lean();
  
  const movieMap = movies.reduce((acc, movie) => {
    acc[movie._id.toString()] = movie;
    return acc;
  }, {});

  const enrichedItems = items.map(item => ({
    ...item,
    movie: movieMap[item.movieId.toString()] || null,
    progressPercentage: item.durationSeconds > 0 
      ? Math.min(100, Math.round((item.progressSeconds / item.durationSeconds) * 100))
      : 0
  })).filter(item => item.movie !== null);

  const total = await this.countDocuments(query);

  return {
    items: enrichedItems,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
};

/**
 * Mark progress as completed
 */
watchProgressSchema.statics.markCompleted = async function(userId, movieId) {
  return this.findOneAndUpdate(
    { userId, movieId },
    { 
      $set: { 
        completed: true,
        lastWatchedAt: new Date()
      }
    },
    { new: true }
  );
};

/**
 * Delete progress
 */
watchProgressSchema.statics.deleteProgress = async function(userId, movieId) {
  return this.deleteOne({ userId, movieId });
};

/**
 * Clear all progress for a user
 */
watchProgressSchema.statics.clearAllProgress = async function(userId) {
  return this.deleteMany({ userId });
};

// ============================================================
// JSON TRANSFORM
// ============================================================

watchProgressSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    ret.progressPercentage = ret.durationSeconds > 0 
      ? Math.min(100, Math.round((ret.progressSeconds / ret.durationSeconds) * 100))
      : 0;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const WatchProgress = mongoose.models.WatchProgress || mongoose.model('WatchProgress', watchProgressSchema);

module.exports = WatchProgress;
