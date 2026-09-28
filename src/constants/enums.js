/**
 * Enum Constants for Movie Streaming Platform
 * Optimized Version - Clean Architecture
 */

const ENUMS = {
  // Authentication Providers
  AUTH_PROVIDER: {
    LOCAL: 'local',
    GOOGLE: 'google',
    FACEBOOK: 'facebook'
  },

  // Movie Availability Status
  MOVIE_AVAILABILITY_STATUS: {
    UPCOMING: 'upcoming',
    RELEASED: 'released',
    ENDED: 'ended',
    UNAVAILABLE: 'unavailable'
  },

  // Movie Types
  MOVIE_TYPE: {
    SERIES: 'series',
    SINGLE: 'single',
    TVSHOW: 'tvshows',
    HOATHINH: 'hoathinh'
  },

  // Movie Status Code (for soft delete and tracking)
  MOVIE_STAT_CD: {
    ACTIVE: 'ACT',
    DELETED: 'DEL'
  },

  // Report Target Types
  REPORT_TARGET_TYPE: {
    MOVIE: 'movie',
    COMMENT: 'comment',
    USER: 'user'
  },

  // Report/Feedback Status
  REPORT_STATUS: {
    PENDING: 'pending',
    REVIEWING: 'reviewing',
    RESOLVED: 'resolved',
    REJECTED: 'rejected'
  },

  // Feedback Status
  FEEDBACK_STATUS: {
    PENDING: 'pending',
    PROCESSED: 'processed',
    RESOLVED: 'resolved'
  },

  // Feedback Types
  FEEDBACK_TYPE: {
    BUG: 'bug',
    FEATURE_REQUEST: 'feature_request',
    GENERAL: 'general'
  },

  // Like Types (for comments and movies)
  LIKE_TYPE: {
    LIKE: 'like',
    DISLIKE: 'dislike'
  },

  // Notification Types
  NOTIFICATION_TYPE: {
    SYSTEM: 'system',
    NEW_MOVIE: 'new_movie',
    MOVIE_RELEASED: 'movie_released',
    COMMENT_REPLY: 'comment_reply',
    COMMENT: 'comment'
  }
};

// Freeze to prevent accidental modifications
Object.freeze(ENUMS);
Object.freeze(ENUMS.AUTH_PROVIDER);
Object.freeze(ENUMS.MOVIE_AVAILABILITY_STATUS);
Object.freeze(ENUMS.MOVIE_TYPE);
Object.freeze(ENUMS.MOVIE_STAT_CD);
Object.freeze(ENUMS.REPORT_TARGET_TYPE);
Object.freeze(ENUMS.REPORT_STATUS);
Object.freeze(ENUMS.FEEDBACK_STATUS);
Object.freeze(ENUMS.FEEDBACK_TYPE);
Object.freeze(ENUMS.LIKE_TYPE);
Object.freeze(ENUMS.NOTIFICATION_TYPE);

module.exports = ENUMS;
