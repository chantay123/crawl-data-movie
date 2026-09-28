/**
 * Watchlist Item Model
 * Source: movie-streaming-optimized-v2.dbml
 * 
 * Individual watchlist items per user.
 * No parent collection needed - each user can have multiple watchlist items.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const watchlistItemSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true
  },
  addedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Unique compound index: userId + movieId
// Prevents duplicate watchlist entries
watchlistItemSchema.index(
  { userId: 1, movieId: 1 },
  { unique: true, name: 'unique_user_movie' }
);

// Index for finding items by user
watchlistItemSchema.index({ userId: 1 });

// Index for finding items by movie
watchlistItemSchema.index({ movieId: 1 });

// Compound index for user's watchlist with sorting
watchlistItemSchema.index(
  { userId: 1, addedAt: -1 },
  { name: 'idx_user_watchlist_recent' }
);

/**
 * Static method to add movie to watchlist
 */
watchlistItemSchema.statics.addToWatchlist = async function(userId, movieId) {
  try {
    const item = await this.create({ userId, movieId });
    return { success: true, item, action: 'added' };
  } catch (error) {
    if (error.code === 11000) {
      return { success: false, action: 'already_exists' };
    }
    throw error;
  }
};

/**
 * Static method to remove movie from watchlist
 */
watchlistItemSchema.statics.removeFromWatchlist = async function(userId, movieId) {
  const result = await this.deleteOne({ userId, movieId });
  return { success: result.deletedCount > 0, action: 'removed' };
};

/**
 * Static method to check if movie is in watchlist
 */
watchlistItemSchema.statics.isInWatchlist = async function(userId, movieId) {
  const count = await this.countDocuments({ userId, movieId });
  return count > 0;
};

/**
 * Static method to get user's watchlist with movie details
 */
watchlistItemSchema.statics.getUserWatchlist = async function(userId, options = {}) {
  const { page = 1, limit = 24 } = options;
  const skip = (page - 1) * limit;

  const Movie = mongoose.model('Movie');

  const items = await this.find({ userId })
    .sort({ addedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  if (items.length === 0) {
    return { items: [], total: 0 };
  }

  const movieIds = items.map(item => item.movieId);
  const movies = await Movie.find({ _id: { $in: movieIds } }).lean();
  
  // Create a map for quick lookup
  const movieMap = movies.reduce((acc, movie) => {
    acc[movie._id.toString()] = movie;
    return acc;
  }, {});

  // Merge watchlist data with movie data
  const enrichedItems = items.map(item => ({
    ...item,
    movie: movieMap[item.movieId.toString()] || null
  })).filter(item => item.movie !== null);

  const total = await this.countDocuments({ userId });

  return {
    items: enrichedItems,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
};

/**
 * Static method to clear user's watchlist
 */
watchlistItemSchema.statics.clearWatchlist = async function(userId) {
  return this.deleteMany({ userId });
};

/**
 * Static method to get watchlist count for a movie
 */
watchlistItemSchema.statics.getWatchlistCount = async function(movieId) {
  return this.countDocuments({ movieId });
};

// JSON transform
watchlistItemSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const WatchlistItem = mongoose.models.WatchlistItem || mongoose.model('WatchlistItem', watchlistItemSchema);

module.exports = WatchlistItem;
