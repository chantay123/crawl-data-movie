/**
 * Comment Like Model
 * Source: movie-streaming-optimized-v2.dbml
 * 
 * Likes for comments. Separate from movie_likes.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const ENUMS = require('../constants/enums');

const commentLikeSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  commentId: {
    type: Schema.Types.ObjectId,
    ref: 'Comment',
    required: true
  },
  type: {
    type: String,
    enum: Object.values(ENUMS.LIKE_TYPE),
    default: ENUMS.LIKE_TYPE.LIKE
  }
}, {
  timestamps: true
});

// Unique compound index: userId + commentId
// Prevents duplicate likes
commentLikeSchema.index(
  { userId: 1, commentId: 1 },
  { unique: true, name: 'unique_user_comment' }
);

// Index for finding likes by comment
commentLikeSchema.index({ commentId: 1 });

// Index for finding likes by user
commentLikeSchema.index({ userId: 1 });

// Method to get like count for a comment
commentLikeSchema.statics.getCommentLikeStats = async function(commentId) {
  const result = await this.aggregate([
    { $match: { commentId: mongoose.Types.ObjectId.createFromHexString(commentId.toString()) } },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 }
      }
    }
  ]);

  const stats = { likes: 0, dislikes: 0 };
  result.forEach(item => {
    if (item._id === ENUMS.LIKE_TYPE.LIKE) stats.likes = item.count;
    if (item._id === ENUMS.LIKE_TYPE.DISLIKE) stats.dislikes = item.count;
  });

  return stats;
};

// Method to toggle like/dislike
commentLikeSchema.statics.toggle = async function(userId, commentId, type) {
  const existing = await this.findOne({ userId, commentId });
  
  if (!existing) {
    await this.create({ userId, commentId, type });
    return { action: 'added', type };
  }
  
  if (existing.type === type) {
    await this.deleteOne({ _id: existing._id });
    return { action: 'removed', type: null };
  }
  
  existing.type = type;
  await existing.save();
  return { action: 'changed', type };
};

// JSON transform
commentLikeSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const CommentLike = mongoose.models.CommentLike || mongoose.model('CommentLike', commentLikeSchema);

module.exports = CommentLike;
