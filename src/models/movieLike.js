/**
 * Movie Like Model
 * Source: movie-streaming-optimized-v2.dbml
 * 
 * Movie likes are separate from comment_likes to avoid ambiguity.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieLikeSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true
  }
}, {
  timestamps: true
});

// Unique compound index: userId + movieId
// Prevents duplicate likes
movieLikeSchema.index(
  { userId: 1, movieId: 1 },
  { unique: true, name: 'unique_user_movie' }
);

// Index for finding likes by user
movieLikeSchema.index({ userId: 1 });

// Index for finding likes by movie
movieLikeSchema.index({ movieId: 1 });

/**
 * Static method to toggle like
 */
movieLikeSchema.statics.toggleLike = async function(userId, movieId) {
  const existing = await this.findOne({ userId, movieId });
  
  if (existing) {
    await this.deleteOne({ _id: existing._id });
    return { liked: false, action: 'unliked' };
  } else {
    await this.create({ userId, movieId });
    return { liked: true, action: 'liked' };
  }
};

/**
 * Static method to check if user liked a movie
 */
movieLikeSchema.statics.isLiked = async function(userId, movieId) {
  const count = await this.countDocuments({ userId, movieId });
  return count > 0;
};

/**
 * Static method to count likes for a movie
 */
movieLikeSchema.statics.getLikeCount = async function(movieId) {
  return this.countDocuments({ movieId });
};

/**
 * Static method to get user's liked movies
 */
movieLikeSchema.statics.getUserLikedMovies = async function(userId, options = {}) {
  const { page = 1, limit = 24 } = options;
  const skip = (page - 1) * limit;

  const Movie = mongoose.model('Movie');

  const items = await this.find({ userId })
    .sort({ createdAt: -1 })
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

// JSON transform
movieLikeSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const MovieLike = mongoose.models.MovieLike || mongoose.model('MovieLike', movieLikeSchema);

module.exports = MovieLike;
