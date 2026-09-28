/**
 * TrailerService - Direct trailer persistence into Movie (nested object).
 *
 * Architecture:
 *   - Trailer is NESTED inside the Movie document. NO separate Trailer collection.
 *   - Use TrailerSchema (defined in movie.ts) – we don't redefine it here.
 *   - If a movie already has trailer.key → skip YouTube search.
 *   - If YouTube returns nothing → trailer = null (do NOT save empty object).
 *   - On YouTube 429:
 *       * If movie already has trailer.key → keep the existing trailer.
 *       * If movie has NO trailer yet → trailer = null, job → RATE_LIMITED, retryAt set.
 *   - YouTube errors NEVER crash the crawler; Movie is still persisted.
 */

const TMDBService = require('./TMDBService');
const YouTubeService = require('./YouTubeService');
const { Movie } = require('../models');
const logger = require('../utils/logger');

class TrailerService {
  /**
   * Search YouTube for a movie's trailer (no DB write).
   * Returns { trailer, status, retryAt, error }
   *   - status: 'FOUND' | 'NOT_FOUND' | 'RATE_LIMITED' | 'ERROR'
   *   - trailer: object | null
   *
   * Public for testing/script reuse.
   */
  async search(movie) {
    if (!movie || !movie.name) {
      return { trailer: null, status: 'NOT_FOUND', retryAt: null, error: null };
    }

    try {
      const result = await YouTubeService.searchTrailer(movie.name, movie.year, movie.originName);
      if (result && result.key) {
        return {
          trailer: {
            name: result.name,
            key: result.key,
            site: 'YouTube',
            type: 'Trailer',
            official: result.official ?? false,
            publishedAt: result.publishedAt ?? null,
            url: `https://www.youtube.com/watch?v=${result.key}`,
            updatedAt: new Date(),
            viewCount: result.viewCount ?? 0
          },
          status: 'FOUND',
          retryAt: null,
          error: null
        };
      }
      return { trailer: null, status: 'NOT_FOUND', retryAt: null, error: null };
    } catch (err) {
      if (err.code === 'RATE_LIMITED' || err.code === 'CIRCUIT_OPEN') {
        const retryAfterMs = err.retryAfterMs || 900000; // default 15 min
        return {
          trailer: null,
          status: 'RATE_LIMITED',
          retryAt: new Date(Date.now() + retryAfterMs),
          error: err
        };
      }
      // Generic error → treat as NOT_FOUND but log
      logger.warn(`[Trailer] Search error for ${movie.name}: ${err.message}`);
      return { trailer: null, status: 'ERROR', retryAt: null, error: err };
    }
  }

  /**
   * Main entry: persist trailer for a movie according to new semantics.
   *
   * @param {Object} movie - Movie document (must have _id, name, trailer?).
   * @returns {Promise<Object>} { trailer, status, saved, retryAt }
   */
  async getTrailer(movie) {
    // 1. Already has trailer with real key → return existing, don't search.
    if (movie && movie.trailer && movie.trailer.key) {
      logger.debug(`[Trailer] Using cached trailer for: ${movie.name}`);
      return {
        trailer: movie.trailer,
        status: 'FOUND',
        saved: false,
        retryAt: null
      };
    }

    // 2. Search YouTube
    const search = await this.search(movie);

    // 3a. Found a trailer → save it.
    if (search.status === 'FOUND' && search.trailer) {
      await this.saveTrailer(movie._id, search.trailer);
      logger.info(`[Trailer] ✅ Saved YouTube trailer for: ${movie.name}`);
      return { trailer: search.trailer, status: 'FOUND', saved: true, retryAt: null };
    }

    // 3b. RATE_LIMITED → if no existing trailer, mark job for retry later.
    if (search.status === 'RATE_LIMITED') {
      // Do NOT touch movie.trailer (it stays null). Just record retry metadata.
      await this.markRateLimited(movie._id, search.retryAt);
      logger.warn(
        `[Trailer] ⏸ RATE_LIMITED for ${movie.name}, retryAt=${search.retryAt?.toISOString()}`
      );
      return { trailer: null, status: 'RATE_LIMITED', saved: false, retryAt: search.retryAt };
    }

    // 3c. NOT_FOUND or generic ERROR → trailer stays null, no empty object saved.
    await this.markNotFound(movie._id);
    logger.info(`[Trailer] ⬜ No trailer found for: ${movie.name}`);
    return { trailer: null, status: search.status, saved: false, retryAt: null };
  }

  /**
   * Save a real trailer (with key) directly to movie.trailer.
   * The trailer field is REPLACED entirely (mongoose set on sub-doc).
   */
  async saveTrailer(movieId, trailer) {
    if (!trailer || !trailer.key) return;
    try {
      await Movie.updateOne(
        { _id: movieId },
        {
          $set: {
            trailer: {
              name: trailer.name || '',
              key: trailer.key,
              site: trailer.site || 'YouTube',
              type: trailer.type || 'Trailer',
              official: !!trailer.official,
              publishedAt: trailer.publishedAt || null,
              url: trailer.url || `https://www.youtube.com/watch?v=${trailer.key}`,
              updatedAt: trailer.updatedAt || new Date(),
              viewCount: trailer.viewCount ?? 0
            },
            'tmdb.trailer_url': trailer.url || `https://www.youtube.com/watch?v=${trailer.key}`,
            trailerJobStatus: 'OK',
            trailerRetryAt: null
          }
        }
      );
      logger.debug(`[Trailer] Saved trailer to movie ${movieId}`);
    } catch (error) {
      logger.error(`[Trailer] Failed to save trailer: ${error.message}`);
    }
  }

  /** Mark job as rate-limited; trailer stays null (or existing). */
  async markRateLimited(movieId, retryAt) {
    try {
      await Movie.updateOne(
        { _id: movieId },
        {
          $set: {
            trailerJobStatus: 'RATE_LIMITED',
            trailerRetryAt: retryAt || new Date(Date.now() + 900000)
          }
        }
      );
    } catch (error) {
      logger.error(`[Trailer] Failed to mark RATE_LIMITED: ${error.message}`);
    }
  }

  /** Mark job as not found; trailer stays null. */
  async markNotFound(movieId) {
    try {
      await Movie.updateOne(
        { _id: movieId },
        { $set: { trailerJobStatus: 'NOT_FOUND', trailerRetryAt: null } }
      );
    } catch (error) {
      logger.error(`[Trailer] Failed to mark NOT_FOUND: ${error.message}`);
    }
  }

  /**
   * Fetch and update trailer for a single movie by slug (admin endpoint).
   */
  async fetchAndUpdateTrailer(slug) {
    try {
      const movie = await Movie.findOne({ slug });
      if (!movie) {
        return { success: false, message: `Movie not found: ${slug}` };
      }

      const result = await this.getTrailer(movie);
      return {
        success: result.status === 'FOUND',
        message:
          result.status === 'FOUND'
            ? `Trailer saved for: ${movie.name}`
            : `No trailer (status=${result.status}) for: ${movie.name}`,
        trailer: result.trailer,
        status: result.status
      };
    } catch (error) {
      logger.error(`[Trailer] fetchAndUpdateTrailer failed for ${slug}: ${error.message}`);
      return { success: false, message: error.message, trailer: null };
    }
  }

  /**
   * Batch retry trailers for movies in RATE_LIMITED state (or no trailer).
   * Skips movies that already have a real trailer.
   */
  async batchUpdateTrailers(limit = 50) {
    logger.info(`[Trailer] Starting batch update (limit: ${limit})`);

    const movies = await Movie.find({
      $or: [
        { trailer: null },
        { trailer: { $exists: false } },
        { 'trailer.key': { $exists: false } },
        { 'trailer.key': '' },
        // Retry rate-limited jobs whose retryAt has passed
        {
          trailerJobStatus: 'RATE_LIMITED',
          trailerRetryAt: { $lte: new Date() }
        }
      ]
    })
      .select('_id name year originName trailer trailerJobStatus trailerRetryAt')
      .limit(limit)
      .lean();

    logger.info(`[Trailer] Found ${movies.length} movies to process`);

    let found = 0, rateLimited = 0, notFound = 0, errors = 0;

    for (const m of movies) {
      try {
        const result = await this.getTrailer(m);
        if (result.status === 'FOUND') found++;
        else if (result.status === 'RATE_LIMITED') rateLimited++;
        else notFound++;
      } catch (err) {
        errors++;
        logger.warn(`[Trailer] Batch failed for ${m.name}: ${err.message}`);
      }
    }

    const stats = {
      total: movies.length,
      found,
      rateLimited,
      notFound,
      errors
    };
    logger.info(`[Trailer] Batch update complete: ${JSON.stringify(stats)}`);
    return stats;
  }

  /**
   * Helper: count movies with REAL trailer (key non-empty).
   */
  async countWithTrailer() {
    return Movie.countDocuments({ 'trailer.key': { $exists: true, $ne: '' } });
  }
}

module.exports = new TrailerService();