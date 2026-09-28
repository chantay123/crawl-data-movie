/**
 * Feedback Model
 * Source: movie_streaming_dbdiagram_v3.dbml
 *
 * User feedback and bug reports.
 * Types: bug, feature_request, general
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const ENUMS = require('../constants/enums');

const feedbackSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  type: {
    type: String,
    enum: Object.values(ENUMS.FEEDBACK_TYPE),
    default: ENUMS.FEEDBACK_TYPE.GENERAL,
    required: true,
    index: true
  },
  subject: {
    type: String,
    required: true,
    trim: true,
    maxlength: 255
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: Object.values(ENUMS.REPORT_STATUS),
    default: ENUMS.REPORT_STATUS.PENDING,
    index: true
  },
  adminResponse: {
    type: String,
    default: ''
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  resolvedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// ============================================================
// INDEXES
// ============================================================

// Index for user feedbacks
feedbackSchema.index({ userId: 1 });

// Index for type filtering
feedbackSchema.index({ type: 1 });

// Index for status filtering
feedbackSchema.index({ status: 1 });

// Index for resolved by
feedbackSchema.index({ resolvedBy: 1 });

// Index for created date sorting
feedbackSchema.index({ createdAt: -1 });

// Compound index for type + status
feedbackSchema.index(
  { type: 1, status: 1 },
  { name: 'idx_type_status' }
);

// ============================================================
// METHODS
// ============================================================

/**
 * Mark feedback as resolved
 */
feedbackSchema.methods.resolve = async function(adminId, response = '') {
  this.status = ENUMS.REPORT_STATUS.RESOLVED;
  this.resolvedBy = adminId;
  this.resolvedAt = new Date();
  if (response) {
    this.adminResponse = response;
  }
  return this.save();
};

/**
 * Mark feedback as rejected
 */
feedbackSchema.methods.reject = async function(adminId, response = '') {
  this.status = ENUMS.REPORT_STATUS.REJECTED;
  this.resolvedBy = adminId;
  this.resolvedAt = new Date();
  if (response) {
    this.adminResponse = response;
  }
  return this.save();
};

/**
 * Mark feedback as under review
 */
feedbackSchema.methods.markReviewing = async function() {
  this.status = ENUMS.REPORT_STATUS.REVIEWING;
  return this.save();
};

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Create feedback
 */
feedbackSchema.statics.createFeedback = async function(data) {
  const { userId, type, subject, content } = data;
  return this.create({ userId, type, subject, content });
};

/**
 * Get feedback by ID with user info
 */
feedbackSchema.statics.getById = async function(id) {
  return this.findById(id)
    .populate('userId', 'fullname email avatar')
    .populate('resolvedBy', 'fullname')
    .lean();
};

/**
 * Get feedbacks with pagination
 */
feedbackSchema.statics.getFeedbacks = async function(filters = {}, options = {}) {
  const { page = 1, limit = 20, sort = '-createdAt' } = options;
  const skip = (page - 1) * limit;

  const query = {};
  if (filters.type) query.type = filters.type;
  if (filters.status) query.status = filters.status;
  if (filters.userId) query.userId = filters.userId;

  const items = await this.find(query)
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .populate('userId', 'fullname email avatar')
    .populate('resolvedBy', 'fullname')
    .lean();

  const total = await this.countDocuments(query);

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
};

/**
 * Get feedback statistics
 */
feedbackSchema.statics.getStats = async function() {
  return this.aggregate([
    {
      $group: {
        _id: { type: '$type', status: '$status' },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.type',
        statuses: {
          $push: {
            status: '$_id.status',
            count: '$count'
          }
        },
        total: { $sum: '$count' }
      }
    }
  ]);
};

feedbackSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const Feedback = mongoose.models.Feedback || mongoose.model('Feedback', feedbackSchema);

module.exports = Feedback;
