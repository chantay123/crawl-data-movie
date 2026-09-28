/**
 * Favorite Item Model - Optimized
 * Clean Architecture - MongoDB Best Practices
 * 
 * User's favorite movies.
 * Merged movie_likes into this collection.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const favoriteItemSchema = new Schema({
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

// ============================================================
// INDEXES
// ============================================================

// Unique compound index: one favorite per user/movie
favoriteItemSchema.index(
  { userId: 1, movieId: 1 },
  { unique: true, name: 'unique_user_movie' }
);

// Compound index for user's favorites with sorting
favoriteItemSchema.index(
  { userId: 1, addedAt: -1 },
  { name: 'idx_user_favorites_recent' }
);

// Index for movie popularity queries
favoriteItemSchema.index({ movieId: 1 }, { name: 'idx_movie_favorites' });

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Add movie to favorites (toggle behavior)
 */
favoriteItemSchema.statics.toggleFavorite = async function(userId, movieId) {
  const existing = await this.findOne({ userId, movieId });
  
  if (existing) {
    await this.deleteOne({ _id: existing._id });
    return { success: true, action: 'removed', favorited: false };
  } else {
    const item = await this.create({ userId, movieId, addedAt: new Date() });
    return { success: true, action: 'added', favorited: true, item };
  }
};

/**
 * Add movie to favorites
 */
favoriteItemSchema.statics.addToFavorites = async function(userId, movieId) {
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
 * Remove movie from favorites
 */
favoriteItemSchema.statics.removeFromFavorites = async function(userId, movieId) {
  const result = await this.deleteOne({ userId, movieId });
  return { success: result.deletedCount > 0, action: 'removed' };
};

/**
 * Check if movie is in favorites
 */
favoriteItemSchema.statics.isFavorited = async function(userId, movieId) {
  const count = await this.countDocuments({ userId, movieId });
  return count > 0;
};

/**
 * Check multiple movies favorited status
 */
favoriteItemSchema.statics.checkMultipleFavorited = async function(userId, movieIds) {
  const favorites = await this.find({ 
    userId, 
    movieId: { $in: movieIds } 
  }).lean();
  
  const favoritedSet = new Set(favorites.map(f => f.movieId.toString()));
  
  return movieIds.reduce((acc, movieId) => {
    acc[movieId.toString()] = favoritedSet.has(movieId.toString());
    return acc;
  }, {});
};

/**
 * Get user's favorites with movie details
 */
favoriteItemSchema.statics.getUserFavorites = async function(userId, options = {}) {
  const { page = 1, limit = 24, sort = '-addedAt' } = options;
  const skip = (page - 1) * limit;

  const Movie = mongoose.model('Movie');

  const items = await this.find({ userId })
    .sort(sort)
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
 * Clear user's favorites
 */
favoriteItemSchema.statics.clearFavorites = async function(userId) {
  return this.deleteMany({ userId });
};

/**
 * Get favorite count for a movie
 */
favoriteItemSchema.statics.getFavoriteCount = async function(movieId) {
  return this.countDocuments({ movieId });
};

/**
 * Get most favorited movies
 */
favoriteItemSchema.statics.getMostFavorited = async function(options = {}) {
  const { limit = 10, days = null } = options;

  const matchStage = {};
  if (days) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    matchStage.addedAt = { $gte: startDate };
  }

  const pipeline = [];
  if (Object.keys(matchStage).length > 0) {
    pipeline.push({ $match: matchStage });
  }

  pipeline.push(
    {
      $group: {
        _id: '$movieId',
        favoriteCount: { $sum: 1 },
        latestAddedAt: { $max: '$addedAt' }
      }
    },
    {
      $sort: { favoriteCount: -1 }
    },
    {
      $limit: limit
    }
  );

  const results = await this.aggregate(pipeline);

  // Populate movie details
  const Movie = mongoose.model('Movie');
  const movieIds = results.map(r => r._id);
  const movies = await Movie.find({ 
    _id: { $in: movieIds },
    isPublished: true,
    isHidden: false
  }).lean();

  const movieMap = movies.reduce((acc, movie) => {
    acc[movie._id.toString()] = movie;
    return acc;
  }, {});

  return results.map(r => ({
    movie: movieMap[r._id.toString()],
    favoriteCount: r.favoriteCount,
    latestAddedAt: r.latestAddedAt
  })).filter(r => r.movie);
};

// ============================================================
// JSON TRANSFORM
// ============================================================

favoriteItemSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const FavoriteItem = mongoose.models.FavoriteItem || mongoose.model('FavoriteItem', favoriteItemSchema);

module.exports = FavoriteItem;
