/**
 * Search History Model - Optimized
 * Clean Architecture - MongoDB Best Practices
 * 
 * Tracks search queries for logged-in and guest users.
 * Nullable userId for guest support.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const searchHistorySchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
    sparse: true
  },
  sessionKey: {
    type: String,
    maxlength: 255,
    default: null,
    index: true,
    sparse: true
  },
  query: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500
  },
  normalizedQuery: {
    type: String,
    trim: true,
    lowercase: true,
    maxlength: 500
  },
  filters: {
    type: Schema.Types.Mixed,
    default: {}
  },
  resultsCount: {
    type: Number,
    default: 0,
    min: 0
  },
  timestamp: {
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

// Sparse compound index for logged-in users
searchHistorySchema.index(
  { userId: 1, query: 1 },
  { unique: true, sparse: true, name: 'unique_user_query' }
);

// Compound index for user search history
searchHistorySchema.index(
  { userId: 1, timestamp: -1 },
  { name: 'idx_user_history' }
);

// Compound index for guest search history
searchHistorySchema.index(
  { sessionKey: 1, timestamp: -1 },
  { name: 'idx_session_history', sparse: true }
);

// Index for popular searches analytics
searchHistorySchema.index({ normalizedQuery: 1 }, { name: 'idx_normalized_query' });

// ============================================================
// PRE-SAVE HOOK
// ============================================================

searchHistorySchema.pre('save', function(next) {
  if (this.isModified('query')) {
    // Create normalized version for analytics
    this.normalizedQuery = this.query
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''); // Remove diacritics
  }
  next();
});

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Record a search query (upsert for logged-in users)
 */
searchHistorySchema.statics.recordSearch = async function(data) {
  const { userId = null, sessionKey = null, query, filters = {}, resultsCount = 0 } = data;

  if (!query || query.trim().length === 0) {
    return null;
  }

  const MAX_HISTORY_ITEMS = 20;

  try {
    let searchRecord;

    if (userId) {
      // For logged-in users: upsert to avoid duplicates
      searchRecord = await this.findOneAndUpdate(
        { userId, query: query.trim() },
        {
          $set: {
            filters,
            resultsCount,
            timestamp: new Date()
          }
        },
        { upsert: true, new: true }
      );

      // Limit history items
      const count = await this.countDocuments({ userId });
      if (count > MAX_HISTORY_ITEMS) {
        const oldestItem = await this.findOne({ userId })
          .sort({ timestamp: 1 })
          .limit(1);
        
        if (oldestItem) {
          await this.findByIdAndDelete(oldestItem._id);
        }
      }
    } else if (sessionKey) {
      // For guests: always create new record
      searchRecord = await this.create({
        sessionKey,
        query: query.trim(),
        filters,
        resultsCount,
        timestamp: new Date()
      });

      // Limit guest history items
      const count = await this.countDocuments({ sessionKey });
      if (count > MAX_HISTORY_ITEMS) {
        const oldestItem = await this.findOne({ sessionKey })
          .sort({ timestamp: 1 })
          .limit(1);
        
        if (oldestItem) {
          await this.findByIdAndDelete(oldestItem._id);
        }
      }
    }

    return searchRecord;
  } catch (error) {
    console.error('Error recording search:', error);
    return null;
  }
};

/**
 * Get user's search history
 */
searchHistorySchema.statics.getUserHistory = async function(userId, options = {}) {
  const { limit = 10 } = options;

  return this.find({ userId })
    .sort({ timestamp: -1 })
    .limit(limit)
    .select('query filters timestamp resultsCount')
    .lean();
};

/**
 * Get guest's search history by session
 */
searchHistorySchema.statics.getSessionHistory = async function(sessionKey, options = {}) {
  const { limit = 10 } = options;

  return this.find({ sessionKey })
    .sort({ timestamp: -1 })
    .limit(limit)
    .select('query filters timestamp resultsCount')
    .lean();
};

/**
 * Get popular searches
 */
searchHistorySchema.statics.getPopularSearches = async function(options = {}) {
  const { limit = 10, days = 30 } = options;
  
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const popular = await this.aggregate([
    {
      $match: {
        timestamp: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: '$normalizedQuery',
        count: { $sum: 1 },
        originalQuery: { $first: '$query' },
        avgResults: { $avg: '$resultsCount' }
      }
    },
    {
      $sort: { count: -1 }
    },
    {
      $limit: limit
    },
    {
      $project: {
        _id: 0,
        query: '$originalQuery',
        normalizedQuery: '$_id',
        searchCount: '$count',
        avgResults: { $round: ['$avgResults', 0] }
      }
    }
  ]);

  return popular;
};

/**
 * Clear user's search history
 */
searchHistorySchema.statics.clearUserHistory = async function(userId) {
  return this.deleteMany({ userId });
};

/**
 * Clear guest's search history
 */
searchHistorySchema.statics.clearSessionHistory = async function(sessionKey) {
  return this.deleteMany({ sessionKey });
};

/**
 * Delete a specific search entry
 */
searchHistorySchema.statics.deleteSearchEntry = async function(userId, query) {
  return this.deleteOne({ userId, query });
};

// ============================================================
// JSON TRANSFORM
// ============================================================

searchHistorySchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.sessionKey; // Don't expose to frontend
    delete ret.normalizedQuery; // Internal use only
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const SearchHistory = mongoose.models.SearchHistory || mongoose.model('SearchHistory', searchHistorySchema);

module.exports = SearchHistory;
