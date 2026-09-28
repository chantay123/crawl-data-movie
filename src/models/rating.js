/**
 * Rating Model
 * Source: movie-streaming-optimized-v2.dbml
 * 
 * Ratings are separate from comments.
 * Each user can only rate a movie once (can be updated).
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ratingSchema = new Schema({
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
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 10,
    validate: {
      validator: Number.isInteger,
      message: 'Rating must be an integer between 1 and 10'
    }
  }
}, {
  timestamps: true
});

// Unique compound index: userId + movieId
// Prevents duplicate ratings
ratingSchema.index(
  { userId: 1, movieId: 1 },
  { unique: true, name: 'unique_user_movie_rating' }
);

// Index for finding ratings by user
ratingSchema.index({ userId: 1 });

// Index for finding ratings by movie
ratingSchema.index({ movieId: 1 });

// Compound index for movie rating aggregation
ratingSchema.index({ movieId: 1, rating: 1 });

// Method to update rating
ratingSchema.methods.updateRating = async function(newRating) {
  this.rating = newRating;
  return this.save();
};

// Static method to upsert rating
ratingSchema.statics.upsertRating = async function(userId, movieId, rating) {
  const result = await this.findOneAndUpdate(
    { userId, movieId },
    { rating },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return result;
};

// Static method to get user's rating for a movie
ratingSchema.statics.getUserRating = async function(userId, movieId) {
  return this.findOne({ userId, movieId }).lean();
};

// Static method to get average rating for a movie
ratingSchema.statics.getAverageRating = async function(movieId) {
  const result = await this.aggregate([
    { $match: { movieId: mongoose.Types.ObjectId.createFromHexString(movieId.toString()) } },
    {
      $group: {
        _id: '$movieId',
        averageRating: { $avg: '$rating' },
        totalRatings: { $sum: 1 }
      }
    }
  ]);
  
  if (result.length === 0) {
    return { averageRating: 0, totalRatings: 0 };
  }
  
  return {
    averageRating: Math.round(result[0].averageRating * 10) / 10,
    totalRatings: result[0].totalRatings
  };
};

// Static method to get rating distribution
ratingSchema.statics.getRatingDistribution = async function(movieId) {
  return this.aggregate([
    { $match: { movieId: mongoose.Types.ObjectId.createFromHexString(movieId.toString()) } },
    {
      $group: {
        _id: '$rating',
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);
};

// Static method to delete rating
ratingSchema.statics.deleteRating = async function(userId, movieId) {
  return this.deleteOne({ userId, movieId });
};

// JSON transform
ratingSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const Rating = mongoose.models.Rating || mongoose.model('Rating', ratingSchema);

module.exports = Rating;
