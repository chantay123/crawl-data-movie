/**
 * Movie Release Reminder Model
 * Source: movie-streaming-optimized-v2.dbml
 * 
 * Stores user reminders for upcoming movie releases.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieReleaseReminderSchema = new Schema({
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
  notifiedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Unique compound index: userId + movieId
// Prevents duplicate reminders
movieReleaseReminderSchema.index(
  { userId: 1, movieId: 1 },
  { unique: true, name: 'unique_user_movie_reminder' }
);

// Index for finding reminders by user
movieReleaseReminderSchema.index({ userId: 1 });

// Index for finding reminders by movie
movieReleaseReminderSchema.index({ movieId: 1 });

// Index for finding pending notifications
movieReleaseReminderSchema.index(
  { notifiedAt: 1 },
  { name: 'idx_pending_notifications' }
);

/**
 * Static method to set reminder
 */
movieReleaseReminderSchema.statics.setReminder = async function(userId, movieId) {
  try {
    const item = await this.create({ userId, movieId });
    return { success: true, item, action: 'created' };
  } catch (error) {
    if (error.code === 11000) {
      return { success: false, action: 'already_exists' };
    }
    throw error;
  }
};

/**
 * Static method to remove reminder
 */
movieReleaseReminderSchema.statics.removeReminder = async function(userId, movieId) {
  return this.deleteOne({ userId, movieId });
};

/**
 * Static method to get user's reminders
 */
movieReleaseReminderSchema.statics.getUserReminders = async function(userId, options = {}) {
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

/**
 * Static method to mark as notified
 */
movieReleaseReminderSchema.statics.markNotified = async function(userId, movieId) {
  return this.findOneAndUpdate(
    { userId, movieId },
    { notifiedAt: new Date() },
    { new: true }
  );
};

/**
 * Static method to get pending notifications
 */
movieReleaseReminderSchema.statics.getPendingNotifications = async function() {
  return this.find({ notifiedAt: null }).lean();
};

// JSON transform
movieReleaseReminderSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const MovieReleaseReminder = mongoose.models.MovieReleaseReminder || mongoose.model('MovieReleaseReminder', movieReleaseReminderSchema);

module.exports = MovieReleaseReminder;
