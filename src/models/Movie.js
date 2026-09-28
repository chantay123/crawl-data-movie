/**
 * Movie Model - Optimized
 * Clean Architecture - MongoDB Best Practices
 * 
 * Central entity for the streaming platform.
 * No episodes - Movie is the main viewing unit.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const ENUMS = require('../constants/enums');

const movieSchema = new Schema({
  // ============================================================
  // SOURCE TRACKING
  // ============================================================
  source: {
    type: String,
    default: 'ophim',
    maxlength: 50,
    index: true
  },
  sourceId: {
    type: String,
    maxlength: 100,
    index: true
  },

  // ============================================================
  // TMDB/IMDB INTEGRATION
  // ============================================================
  tmdb: {
    type: {
      type: String,
      maxlength: 50,
      default: null
    },
    id: {
      type: String,
      maxlength: 50,
      default: '',
      index: true,
      sparse: true
    },
    season: {
      type: Number,
      default: null
    },
    vote_average: {
      type: Number,
      default: 0,
      min: 0,
      max: 10
    },
    vote_count: {
      type: Number,
      default: 0,
      min: 0
    },
    trailer_url: {
      type: String,
      maxlength: 500,
      default: ''
    }
  },

  // ============================================================
  // TRAILER (YouTube) - NESTED OBJECT, NO Trailer collection
  // Trailer được lưu TRỰC TIẾP trong Movie dưới dạng nested object.
  // Không tạo Trailer collection, không có trailerId / reference.
  // ============================================================
  trailer: {
    type: new Schema({
      name: { type: String, maxlength: 255, default: '' },
      key: { type: String, maxlength: 50, default: '', index: true, sparse: true },
      site: { type: String, maxlength: 20, default: '' },
      type: { type: String, maxlength: 20, default: '' },
      official: { type: Boolean, default: false },
      publishedAt: { type: Date, default: null },
      url: { type: String, maxlength: 500, default: '' },
      updatedAt: { type: Date, default: null },
      viewCount: { type: Number, default: 0, min: 0 }
    }, { _id: false }),
    default: null
  },
  imdb: {
    id: {
      type: String,
      maxlength: 50,
      default: ''
    }
  },

  // ============================================================
  // CORE MOVIE INFO
  // ============================================================
  name: {
    type: String,
    required: true,
    maxlength: 500,
    trim: true
  },
  originName: {
    type: String,
    maxlength: 500,
    trim: true
  },
  content: {
    type: String,
    default: ''
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    maxlength: 500,
    trim: true,
    lowercase: true,
    index: true
  },

  // ============================================================
  // TYPE & STATUS
  // ============================================================
  type: {
    type: String,
    enum: Object.values(ENUMS.MOVIE_TYPE),
    default: ENUMS.MOVIE_TYPE.SERIES,
    index: true
  },
  status: {
    type: String,
    default: 'completed',
    index: true
  },
  availabilityStatus: {
    type: String,
    enum: Object.values(ENUMS.MOVIE_AVAILABILITY_STATUS),
    default: ENUMS.MOVIE_AVAILABILITY_STATUS.RELEASED,
    index: true
  },

  // ============================================================
  // MEDIA URLS
  // ============================================================
  thumbUrl: {
    type: String,
    maxlength: 500,
    default: ''
  },
  posterUrl: {
    type: String,
    maxlength: 500,
    default: ''
  },
  backdropUrl: {
    type: String,
    maxlength: 500,
    default: ''
  },

  // ============================================================
  // EPISODE INFO
  // ============================================================
  time: {
    type: String,
    maxlength: 100,
    default: ''
  },
  episodeCurrent: {
    type: String,
    maxlength: 100,
    default: ''
  },
  episodeTotal: {
    type: String,
    maxlength: 100,
    default: ''
  },
  lang: {
    type: String,
    maxlength: 50,
    default: 'Vietsub'
  },
  notify: {
    type: String,
    maxlength: 255,
    default: ''
  },
  showtimes: {
    type: String,
    maxlength: 255,
    default: ''
  },

  // ============================================================
  // RELEASE INFO
  // ============================================================
  releaseDate: {
    type: Date,
    default: null,
    index: true
  },

  // ============================================================
  // STATS (CACHED AGGREGATES)
  // ============================================================
  viewCount: {
    type: Number,
    default: 0,
    min: 0
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 10
  },

  // ============================================================
  // PEOPLE (EMBEDDED ARRAYS)
  // ============================================================
  actor: [{
    type: String,
    maxlength: 255
  }],
  director: [{
    type: String,
    maxlength: 255
  }],

  // ============================================================
  // FLAGS
  // ============================================================
  isCopyright: {
    type: Boolean,
    default: false
  },
  chieurap: {
    type: Boolean,
    default: false
  },
  subDocquyen: {
    type: Boolean,
    default: false
  },
  isHidden: {
    type: Boolean,
    default: false,
    index: true
  },
  isPublished: {
    type: Boolean,
    default: true,
    index: true
  },
  notifySubscribers: {
    type: Boolean,
    default: false,
    index: true,
    note: 'Useful for upcoming/release announcements'
  },

  // ============================================================
  // EPISODES (EMBEDDED)
  // ============================================================
  episodes: [
    {
      server_name: { 
        type: String, 
        required: true 
      },
      server_data: [
        {
          name: { 
            type: String, 
            required: true 
          },
          slug: { 
            type: String, 
            required: true 
          },
          filename: { 
            type: String, 
            required: true 
          },
          link_embed: { 
            type: String, 
            default: '' 
          },
          link_m3u8: { 
            type: String, 
            default: '' 
          }
        }
      ]
    }
  ],

  // ============================================================
  // DATA MANAGEMENT FIELDS
  // ============================================================
  dateLastMain: {
    type: Date,
    default: Date.now,
    index: true
  },
  effDate: {
    type: Date,
    default: () => new Date('2026-08-27')
  },
  statCd: {
    type: String,
    enum: Object.values(ENUMS.MOVIE_STAT_CD),
    default: ENUMS.MOVIE_STAT_CD.ACTIVE,
    index: true
  },

  // ============================================================
  // SOURCE TIMESTAMPS
  // ============================================================
  sourceCreatedAt: {
    type: Date,
    default: null
  },
  sourceModifiedAt: {
    type: Date,
    default: null
  },

  // ============================================================
  // TRAILER RATE LIMIT TRACKING
  // Lưu trạng thái job trailer khi gặp 429 để retry sau cooldown.
  // ============================================================
  trailerJobStatus: {
    type: String,
    enum: ['OK', 'RATE_LIMITED', 'NOT_FOUND'],
    default: 'OK'
  },
  trailerRetryAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// ============================================================
// INDEXES
// ============================================================

// Compound index for source tracking
movieSchema.index({ source: 1, sourceId: 1 }, { name: 'idx_source_tracking' });

// Index for TMDB lookup
movieSchema.index({ 'tmdb.id': 1 }, { name: 'idx_tmdb_id', sparse: true });

// Index for IMDB lookup
movieSchema.index({ 'imdb.id': 1 }, { name: 'idx_imdb_id', sparse: true });

// Compound index for filtered queries (most common)
movieSchema.index(
  { isPublished: 1, isHidden: 1, statCd: 1, releaseDate: -1 },
  { name: 'idx_published_queries' }
);

// Compound index for type filtering
movieSchema.index(
  { type: 1, year: 1, rating: -1 },
  { name: 'idx_type_year_rating' }
);

// Text index for search
movieSchema.index(
  { name: 'text', originName: 'text', content: 'text' },
  { 
    name: 'idx_text_search',
    weights: { name: 10, originName: 5, content: 1 }
  }
);

// ============================================================
// METHODS
// ============================================================

/**
 * Check if movie is available for viewing
 */
movieSchema.methods.isAvailable = function() {
  return !this.isHidden && 
         this.isPublished && 
         this.statCd === ENUMS.MOVIE_STAT_CD.ACTIVE &&
         this.availabilityStatus === ENUMS.MOVIE_AVAILABILITY_STATUS.RELEASED;
};

/**
 * Increment view count (use carefully - better to aggregate from movie_views)
 */
movieSchema.methods.incrementViews = async function() {
  this.viewCount += 1;
  return this.save();
};

/**
 * Update availability status based on release date
 */
movieSchema.methods.updateAvailabilityStatus = async function() {
  if (!this.releaseDate) return;

  const now = new Date();
  if (this.releaseDate > now) {
    if (this.availabilityStatus !== ENUMS.MOVIE_AVAILABILITY_STATUS.UPCOMING) {
      this.availabilityStatus = ENUMS.MOVIE_AVAILABILITY_STATUS.UPCOMING;
      await this.save();
    }
  } else {
    if (this.availabilityStatus === ENUMS.MOVIE_AVAILABILITY_STATUS.UPCOMING) {
      this.availabilityStatus = ENUMS.MOVIE_AVAILABILITY_STATUS.RELEASED;
      await this.save();
    }
  }
};

/**
 * Soft delete movie
 */
movieSchema.methods.softDelete = async function() {
  this.statCd = ENUMS.MOVIE_STAT_CD.DELETED;
  this.dateLastMain = new Date();
  return this.save();
};

/**
 * Restore soft deleted movie
 */
movieSchema.methods.restore = async function() {
  this.statCd = ENUMS.MOVIE_STAT_CD.ACTIVE;
  this.dateLastMain = new Date();
  return this.save();
};

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Find available movies with pagination
 */
movieSchema.statics.findAvailable = function(query = {}, options = {}) {
  const { page = 1, limit = 24, sort = '-updatedAt' } = options;
  const skip = (page - 1) * limit;

  return this.find({
    isHidden: false,
    isPublished: true,
    statCd: ENUMS.MOVIE_STAT_CD.ACTIVE,
    availabilityStatus: ENUMS.MOVIE_AVAILABILITY_STATUS.RELEASED,
    ...query
  })
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .lean();
};

/**
 * Find upcoming movies
 */
movieSchema.statics.findUpcoming = function(options = {}) {
  const { page = 1, limit = 24 } = options;
  const skip = (page - 1) * limit;

  return this.find({
    isHidden: false,
    isPublished: true,
    statCd: ENUMS.MOVIE_STAT_CD.ACTIVE,
    availabilityStatus: ENUMS.MOVIE_AVAILABILITY_STATUS.UPCOMING
  })
    .sort({ releaseDate: 1 })
    .skip(skip)
    .limit(limit)
    .lean();
};

/**
 * Update dateLastMain before save
 */
movieSchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew) {
    this.dateLastMain = new Date();
  }
  next();
});

// ============================================================
// JSON TRANSFORM
// ============================================================

movieSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

const Movie = mongoose.models.Movie || mongoose.model('Movie', movieSchema);

module.exports = Movie;
