/**
 * Comment Model - Optimized
 * Clean Architecture - MongoDB Best Practices
 * 
 * Features:
 * - Nested replies via parentId
 * - Cached like/dislike counts (CommentLike table for actual data)
 * - Soft delete support
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const commentSchema = new Schema({
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
  parentId: {
    type: Schema.Types.ObjectId,
    ref: 'Comment',
    default: null,
    index: true
  },
  content: {
    type: String,
    required: true,
    trim: true,
    maxlength: 5000
  },
  
  // Cached like/dislike counts (actual data in CommentLike table)
  likeCount: {
    type: Number,
    default: 0,
    min: 0
  },
  dislikeCount: {
    type: Number,
    default: 0,
    min: 0
  },
  
  isEdited: {
    type: Boolean,
    default: false
  },
  isHidden: {
    type: Boolean,
    default: false,
    index: true
  },
  deletedAt: {
    type: Date,
    default: null,
    index: true
  }
}, {
  timestamps: true
});

// ============================================================
// INDEXES
// ============================================================

// Compound index for movie comments (most common query)
commentSchema.index({ movieId: 1, createdAt: -1 }, { name: 'idx_movie_comments' });

// Compound index for user comments
commentSchema.index({ userId: 1, createdAt: -1 }, { name: 'idx_user_comments' });

// Compound index for replies
commentSchema.index({ parentId: 1, createdAt: 1 }, { name: 'idx_replies' });

// Compound index for moderation
commentSchema.index({ isHidden: 1, deletedAt: 1 }, { name: 'idx_moderation' });

// ============================================================
// METHODS
// ============================================================

/**
 * Soft delete comment
 */
commentSchema.methods.softDelete = async function() {
  this.deletedAt = new Date();
  return this.save();
};

/**
 * Edit comment content
 */
commentSchema.methods.editContent = async function(newContent) {
  this.content = newContent;
  this.isEdited = true;
  return this.save();
};

/**
 * Hide comment (moderation)
 */
commentSchema.methods.hide = async function() {
  this.isHidden = true;
  return this.save();
};

/**
 * Unhide comment
 */
commentSchema.methods.unhide = async function() {
  this.isHidden = false;
  return this.save();
};

/**
 * Toggle like by user (uses CommentLike table)
 */
commentSchema.methods.toggleLike = async function(userId) {
  const CommentLike = require('./commentLike');
  const ENUMS = require('../constants/enums');
  
  const result = await CommentLike.toggle(userId, this._id, ENUMS.LIKE_TYPE.LIKE);
  
  // Update cached counts
  const stats = await CommentLike.getCommentLikeStats(this._id);
  this.likeCount = stats.likes;
  this.dislikeCount = stats.dislikes;
  await this.save();
  
  return result;
};

/**
 * Toggle dislike by user (uses CommentLike table)
 */
commentSchema.methods.toggleDislike = async function(userId) {
  const CommentLike = require('./commentLike');
  const ENUMS = require('../constants/enums');
  
  const result = await CommentLike.toggle(userId, this._id, ENUMS.LIKE_TYPE.DISLIKE);
  
  // Update cached counts
  const stats = await CommentLike.getCommentLikeStats(this._id);
  this.likeCount = stats.likes;
  this.dislikeCount = stats.dislikes;
  await this.save();
  
  return result;
};

/**
 * Check if user liked this comment
 */
commentSchema.methods.isLikedBy = async function(userId) {
  const CommentLike = require('./commentLike');
  const ENUMS = require('../constants/enums');
  const like = await CommentLike.findOne({ userId, commentId: this._id, type: ENUMS.LIKE_TYPE.LIKE });
  return !!like;
};

/**
 * Check if user disliked this comment
 */
commentSchema.methods.isDislikedBy = async function(userId) {
  const CommentLike = require('./commentLike');
  const ENUMS = require('../constants/enums');
  const dislike = await CommentLike.findOne({ userId, commentId: this._id, type: ENUMS.LIKE_TYPE.DISLIKE });
  return !!dislike;
};

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Get comments for a movie with pagination
 */
commentSchema.statics.getMovieComments = async function(movieId, options = {}) {
  const { page = 1, limit = 10, sort = 'newest' } = options;
  const skip = (page - 1) * limit;

  const sortOption = sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };

  const items = await this.find({
    movieId,
    parentId: null,
    deletedAt: null,
    isHidden: false
  })
    .sort(sortOption)
    .skip(skip)
    .limit(limit)
    .populate('userId', 'fullname avatar')
    .lean();

  const total = await this.countDocuments({
    movieId,
    parentId: null,
    deletedAt: null,
    isHidden: false
  });

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
};

/**
 * Get replies for a comment
 */
commentSchema.statics.getReplies = async function(commentId) {
  return this.find({
    parentId: commentId,
    deletedAt: null,
    isHidden: false
  })
    .sort({ createdAt: 1 })
    .populate('userId', 'fullname avatar')
    .lean();
};

/**
 * Count comments for a movie
 */
commentSchema.statics.getCommentCount = async function(movieId) {
  return this.countDocuments({ 
    movieId, 
    deletedAt: null,
    isHidden: false
  });
};

// ============================================================
// JSON TRANSFORM
// ============================================================

commentSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const Comment = mongoose.models.Comment || mongoose.model('Comment', commentSchema);

module.exports = Comment;
