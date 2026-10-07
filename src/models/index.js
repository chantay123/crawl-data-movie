/**
 * Models Index - Crawler Copy
 * Clean Architecture - MongoDB Best Practices
 *
 * Centralized export of all models.
 * Import models from here instead of individual files.
 *
 * Source: All models migrated from backend/src/models/
 */

// ============================================================
// User & Authentication
// ============================================================
const User = require('./user');

// ============================================================
// Movies & Master Data
// ============================================================
const Movie = require('./movie');
const Category = require('./category');
const Country = require('./country');
const Year = require('./year');
const Format = require('./format');
const MovieCategory = require('./movieCategory');
const MovieCountry = require('./movieCountry');
const MovieYear = require('./movieYear');
const MovieFormat = require('./movieFormat');

// ============================================================
// People
// ============================================================
const Actor = require('./actor');
const Director = require('./director');
const MovieActor = require('./movieActor');
const MovieDirector = require('./movieDirector');

// ============================================================
// User Interactions
// ============================================================
const Comment = require('./comment');
const CommentLike = require('./commentLike');
const Rating = require('./rating');
const MovieLike = require('./movieLike');
const MovieView = require('./movieView');
const WatchProgress = require('./watchProgress');

// ============================================================
// User Lists
// ============================================================
const WatchlistItem = require('./watchlistItem');
const FavoriteItem = require('./favoriteItem');
const MovieReleaseReminder = require('./movieReleaseReminder');

// ============================================================
// Search
// ============================================================
const SearchHistory = require('./searchHistory');

// ============================================================
// System
// ============================================================
const Report = require('./report');
const Feedback = require('./feedback');
const Notification = require('./notification');

// ============================================================
// Trailer Crawler
// ============================================================
const TrailerCrawlerCheckpoint = require('./trailerCrawlerCheckpoint');

module.exports = {
  // User & Authentication
  User,

  // Movies & Master Data
  Movie,
  Category,
  Country,
  Year,
  Format,
  MovieCategory,
  MovieCountry,
  MovieYear,
  MovieFormat,

  // People
  Actor,
  Director,
  MovieActor,
  MovieDirector,

  // User Interactions
  Comment,
  CommentLike,
  Rating,
  MovieLike,
  MovieView,
  WatchProgress,

  // User Lists
  WatchlistItem,
  FavoriteItem,
  MovieReleaseReminder,

  // Search
  SearchHistory,

  // System
  Report,
  Feedback,
  Notification,

  // Trailer Crawler
  TrailerCrawlerCheckpoint,
};
