/**
 * Movie View Model - Optimized
 * Clean Architecture - MongoDB Best Practices
 * 
 * Event log for movie views.
 * Used for analytics and trending calculations.
 * movie.viewCount is a cached aggregate.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieViewSchema = new Schema({
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  sessionId: {
    type: String,
    maxlength: 255,
    default: null
  },
  watchedSeconds: {
    type: Number,
    default: 0,
    min: 0
  },
  ipAddress: {
    type: String,
    maxlength: 45,
    default: null
  },
  userAgent: {
    type: String,
    default: null
  },
  viewedAt: {
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

// Compound index for movie view analytics
movieViewSchema.index(
  { movieId: 1, viewedAt: -1 },
  { name: 'idx_movie_views' }
);

// Compound index for user view history
movieViewSchema.index(
  { userId: 1, viewedAt: -1 },
  { name: 'idx_user_views' }
);

// Compound index for trending calculations
movieViewSchema.index(
  { viewedAt: -1, movieId: 1 },
  { name: 'idx_trending' }
);

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Record a movie view
 */
movieViewSchema.statics.recordView = async function(data) {
  const { movieId, userId = null, sessionId = null, watchedSeconds = 0, ipAddress = null, userAgent = null } = data;

  const view = await this.create({
    movieId,
    userId,
    sessionId,
    watchedSeconds,
    ipAddress,
    userAgent,
    viewedAt: new Date()
  });

  // Update movie view count (cached aggregate)
  const Movie = mongoose.model('Movie');
  await Movie.findByIdAndUpdate(movieId, { $inc: { viewCount: 1 } });

  return view;
};

/**
 * Get view count for a movie in a date range
 */
movieViewSchema.statics.getViewCount = async function(movieId, startDate = null, endDate = null) {
  const query = { movieId };
  
  if (startDate || endDate) {
    query.viewedAt = {};
    if (startDate) query.viewedAt.$gte = startDate;
    if (endDate) query.viewedAt.$lte = endDate;
  }

  return this.countDocuments(query);
};

/**
 * Get trending movies (most viewed in time period)
 */
movieViewSchema.statics.getTrending = async function(options = {}) {
  const { 
    limit = 10, 
    days = 7,
    startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  } = options;

  const trending = await this.aggregate([
    {
      $match: {
        viewedAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: '$movieId',
        viewCount: { $sum: 1 },
        uniqueUsers: { $addToSet: '$userId' }
      }
    },
    {
      $project: {
        movieId: '$_id',
        viewCount: 1,
        uniqueUserCount: { $size: { $ifNull: ['$uniqueUsers', []] } }
      }
    },
    {
      $sort: { viewCount: -1 }
    },
    {
      $limit: limit
    }
  ]);

  // Populate movie details
  const Movie = mongoose.model('Movie');
  const movieIds = trending.map(t => t.movieId);
  const movies = await Movie.find({ 
    _id: { $in: movieIds },
    isPublished: true,
    isHidden: false
  }).lean();

  const movieMap = movies.reduce((acc, movie) => {
    acc[movie._id.toString()] = movie;
    return acc;
  }, {});

  return trending.map(t => ({
    movie: movieMap[t.movieId.toString()],
    viewCount: t.viewCount,
    uniqueUserCount: t.uniqueUserCount
  })).filter(t => t.movie);
};

/**
 * Get user's view history
 */
movieViewSchema.statics.getUserHistory = async function(userId, options = {}) {
  const { page = 1, limit = 24 } = options;
  const skip = (page - 1) * limit;

  const Movie = mongoose.model('Movie');

  const views = await this.find({ userId })
    .sort({ viewedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  if (views.length === 0) {
    return { items: [], total: 0 };
  }

  const movieIds = [...new Set(views.map(v => v.movieId))];
  const movies = await Movie.find({ _id: { $in: movieIds } }).lean();

  const movieMap = movies.reduce((acc, movie) => {
    acc[movie._id.toString()] = movie;
    return acc;
  }, {});

  const items = views.map(view => ({
    ...view,
    movie: movieMap[view.movieId.toString()]
  })).filter(item => item.movie);

  const total = await this.countDocuments({ userId });

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
};

// ============================================================
// JSON TRANSFORM
// ============================================================

movieViewSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const MovieView = mongoose.models.MovieView || mongoose.model('MovieView', movieViewSchema);

module.exports = MovieView;
