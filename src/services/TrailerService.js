/**
 * TrailerService - YouTube-only trailer pipeline.
 *
 * Single source of truth for trailer data:
 *   - Movies (nested `Movie.trailer` OBJECT - no Trailer collection)
 *   - Lock + cooldown + dedupe handled in-process
 *   - YouTube is the ONLY trailer source; TMDB is NOT used
 *   - 429 / quota / circuit-open => keep trailer untouched, schedule retry
 *
 * GUARANTEES:
 *   - Never overwrites an existing valid trailer (key OR url)
 *   - Never sets `trailer = null` when YouTube fails (only `trailerJobStatus`)
 *   - Only writes `trailer` when YouTube returns a valid result
 */

const YouTubeService = require('./YouTubeService');
const rateLimiter = require('../utils/youtubeRateLimiter');
const trailerState = require('../utils/trailerState');
const { Movie } = require('../models');
const config = require('../config');
const logger = require('../utils/logger');

// Default cooldown if Retry-After header is missing (15 minutes).
const DEFAULT_RETRY_AFTER_MS = 15 * 60 * 1000;

// Allowed trailer batch sizes (requirement: configurable 10 / 20 / 30 / 40)
const ALLOWED_BATCH_SIZES = [10, 20, 30, 40];

function _sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

class TrailerService {
  /**
   * Remaining cooldown of the YouTube circuit breaker (ms). 0 if circuit is not OPEN.
   * @private
   */
  _circuitRemainingMs() {
    try {
      if (!rateLimiter.isCircuitOpen()) return 0;
      return Math.max(0, rateLimiter.cb.cooldownMs - (Date.now() - rateLimiter.cb.openedAt));
    } catch (_) {
      return DEFAULT_RETRY_AFTER_MS;
    }
  }

  /**
   * Extract year from `releaseDate` (schema does not store `year`).
   * @private
   */
  _yearOf(movie) {
    if (movie?.year) return movie.year;
    const rd = movie?.releaseDate;
    if (rd) {
      const d = rd instanceof Date ? rd : new Date(rd);
      if (!Number.isNaN(d.getTime())) return d.getUTCFullYear();
    }
    return null;
  }

  /**
   * Search YouTube for a trailer (the ONLY trailer source).
   *
   * ⭐ STATUS CONTRACT (yêu cầu #6, #4):
   *   - 'FOUND'          → trailer object (with .key)
   *   - 'NOT_FOUND'      → YouTube reachable, ALL queries exhausted, no trailer
   *   - 'RATE_LIMITED'   → YouTube blocked (429 / COOLDOWN / CIRCUIT_OPEN / QUOTA)
   *                         trailer in DB stays untouched, will be retried
   *   - 'RETRY_PENDING'  → in-memory retry queue, will be retried soon
   *   - 'ERROR'          → network / 5xx (treat like RATE_LIMITED for safety)
   *
   * ⭐ BUGFIX (yêu cầu #1, #5):
   *   RATE_LIMITED / COOLDOWN / CIRCUIT_OPEN / TIMEOUT / ERROR NEVER produces
   *   NOT_FOUND. NOT_FOUND is ONLY possible when YouTube is healthy AND all
   *   configured queries returned empty.
   *
   * @param {Object} movie
   * @returns {Promise<{trailer:Object|null, status:string, retryAt:Date|null, error:Error|null, source:string|null, code?:string}>}
   */
  async search(movie) {
    if (!movie || !movie.name) {
      return { trailer: null, status: 'NOT_FOUND', retryAt: null, error: null, source: null };
    }

    // ⭐ Pre-check: YouTube disabled or circuit OPEN => SKIP, return RATE_LIMITED
    // (this is the most common "false NOT_FOUND" if we return null here).
    if (!YouTubeService.isAvailable()) {
      const circuitOpen = rateLimiter.isCircuitOpen();
      const retryAfterMs = circuitOpen
        ? Math.max(1000, this._circuitRemainingMs())
        : DEFAULT_RETRY_AFTER_MS;

      // ⭐ BUGFIX: log "RATE_LIMITED / RETRY_PENDING" instead of misleading
      // "trailer=null" wording. trailer field in DB is NOT touched.
      logger.warn(
        `[Trailer] ⏸ RATE_LIMITED for "${movie.name}" — YouTube ` +
        `${circuitOpen ? 'CIRCUIT_OPEN' : 'DISABLED'}, ` +
        `retry in ~${Math.round(retryAfterMs / 1000)}s. ` +
        `DB trailer field UNCHANGED (will be retried).`
      );
      return {
        trailer: null,
        status: 'RATE_LIMITED',
        code: circuitOpen ? 'CIRCUIT_OPEN' : 'DISABLED',
        retryAt: new Date(Date.now() + retryAfterMs),
        error: null,
        source: null,
      };
    }

    try {
      // ⭐ Pass the WHOLE movie document so YouTubeService can extract alternate
      // titles from `content` (yêu cầu #2/#3). Falls back to legacy positional
      // args if movie is not an object.
      const result = await YouTubeService.searchTrailer(movie);
      if (result && result.key) {
        return {
          trailer: {
            name: result.name,
            key: result.key,
            site: 'YouTube',
            type: result.type || 'Trailer',
            official: result.official ?? false,
            publishedAt: result.publishedAt ?? null,
            url: result.url || `https://www.youtube.com/watch?v=${result.key}`,
            updatedAt: new Date(),
            viewCount: result.viewCount ?? 0,
          },
          status: 'FOUND',
          retryAt: null,
          error: null,
          source: 'youtube',
        };
      }
      // ⭐ null without throw = YouTube healthy, all queries exhausted, no trailer.
      // This is the ONLY path that can produce NOT_FOUND.
      logger.info(
        `[Trailer] ⬜ NOT_FOUND for "${movie.name}" — YouTube healthy, ` +
        `all queries exhausted, no trailer. Will mark movie as NOT_FOUND.`
      );
      return { trailer: null, status: 'NOT_FOUND', retryAt: null, error: null, source: null };
    } catch (err) {
      // ⭐ BUGFIX: RATE_LIMITED / CIRCUIT_OPEN / QUOTA_EXCEEDED must NEVER be
      // treated as NOT_FOUND. These are transient, trailer stays untouched.
      if (err.code === 'RATE_LIMITED' || err.code === 'CIRCUIT_OPEN' || err.code === 'QUOTA_EXCEEDED') {
        const retryAfterMs = err.retryAfterMs || DEFAULT_RETRY_AFTER_MS;
        logger.warn(
          `[Trailer] ⏸ RATE_LIMITED for "${movie.name}" — YouTube ` +
          `threw ${err.code}, retry in ~${Math.round(retryAfterMs / 1000)}s. ` +
          `DB trailer field UNCHANGED (will be retried).`
        );
        return {
          trailer: null,
          status: 'RATE_LIMITED',
          code: err.code,
          retryAt: new Date(Date.now() + retryAfterMs),
          error: err,
          source: null,
        };
      }
      // ⭐ TIMEOUT also treated as RATE_LIMITED (transient, retry later)
      if (err.code === 'TIMEOUT') {
        const retryAfterMs = err.retryAfterMs || DEFAULT_RETRY_AFTER_MS;
        logger.warn(
          `[Trailer] ⏸ RATE_LIMITED for "${movie.name}" — YouTube ` +
          `TIMEOUT, retry in ~${Math.round(retryAfterMs / 1000)}s. ` +
          `DB trailer field UNCHANGED (will be retried).`
        );
        return {
          trailer: null,
          status: 'RATE_LIMITED',
          code: 'TIMEOUT',
          retryAt: new Date(Date.now() + retryAfterMs),
          error: err,
          source: null,
        };
      }
      // Generic error (network / 5xx) => treat as RATE_LIMITED for safety
      // (yêu cầu #1: ERROR never sets trailer=null, always retry later)
      logger.warn(
        `[Trailer] ⏸ RATE_LIMITED for "${movie.name}" — YouTube search error ` +
        `(${err.message}). DB trailer field UNCHANGED (will be retried).`
      );
      return {
        trailer: null,
        status: 'RATE_LIMITED',
        code: 'ERROR',
        retryAt: new Date(Date.now() + DEFAULT_RETRY_AFTER_MS),
        error: err,
        source: null,
      };
    }
  }

  /**
   * MAIN ENTRY: process trailer for one movie (lock + cooldown + dedupe).
   *
   * GUARANTEES:
   *   - Lock per movie => same movie is NOT processed twice in parallel
   *   - retryAt         => now < retryAt => SKIP, no network call
   *   - dedupe window   => do not re-process recently processed movie within N ms
   *   - valid trailer   => keep as-is, NEVER write null
   *
   * @param {Object} movie
   * @param {Object} [opts]
   * @param {boolean} [opts.force=false] Bypass dedupe window (admin/manual)
   * @param {boolean} [opts.skipCooldown=false] Bypass cooldown
   * @returns {Promise<{trailer, status, saved, retryAt, source, skipped?}>}
   */
  async getTrailer(movie, opts = {}) {
    if (!movie) {
      return { trailer: null, status: 'SKIPPED', saved: false, retryAt: null, source: null, skipped: true };
    }

    const force = !!opts.force;
    const skipCooldown = !!opts.skipCooldown;
    const key = String(movie._id || movie.slug || movie.name || '');

    // -----------------------------------------------------------------
    // GUARD 0: VALID TRAILER EXISTS (key OR url) => keep it, skip search
    // - Trailer is a nested OBJECT inside Movie (NO Trailer collection)
    // - Only one of key/url needs to be non-empty
    // - Any failure (RATE_LIMITED / ERROR / TIMEOUT / NOT_FOUND) MUST NOT
    //   overwrite the existing trailer or set trailer = null
    // -----------------------------------------------------------------
    if (movie.trailer && (movie.trailer.key || movie.trailer.url)) {
      const existingKey = movie.trailer.key || '';
      const existingUrl = movie.trailer.url || '';
      logger.debug(
        `[Trailer] Keeping existing trailer for "${movie.name}" (key=${existingKey}, url=${existingUrl})`
      );
      return {
        trailer: movie.trailer,
        status: 'FOUND',
        saved: false,
        retryAt: null,
        source: 'existing',
        skipped: true,
      };
    }

    // -----------------------------------------------------------------
    // GUARD 1: DEDUPE WINDOW => recently processed movie => skip
    // -----------------------------------------------------------------
    if (!force && trailerState.isRecentlyProcessed(key)) {
      const remaining = Math.round(trailerState.dedupeRemainingMs(key) / 1000);
      logger.debug(
        `[Trailer] SKIP "${movie.name}" - deduped (processed <${remaining}s ago)`
      );
      return {
        trailer: null,
        status: 'SKIPPED',
        saved: false,
        retryAt: trailerState.getCooldown(key)?.retryAt || null,
        source: null,
        skipped: true,
      };
    }

    // -----------------------------------------------------------------
    // GUARD 2: RETRY-AT COOLDOWN => now < retryAt => skip
    // -----------------------------------------------------------------
    if (!skipCooldown) {
      const cd = trailerState.shouldSkipForCooldown(key);
      if (cd.skip) {
        const remaining = Math.round(cd.remainingMs / 1000);
        logger.info(
          `[Trailer] SKIP "${movie.name}" - retry scheduled ` +
          `(status=${cd.reason}, retryAt=${cd.retryAt?.toISOString()}, ~${remaining}s remaining)`
        );
        return {
          trailer: null,
          status: 'SKIPPED',
          saved: false,
          retryAt: cd.retryAt,
          source: null,
          skipped: true,
          skipReason: cd.reason,
        };
      }
    }

    // -----------------------------------------------------------------
    // GUARD 3: IN-FLIGHT LOCK => same movie cannot run twice in parallel
    // -----------------------------------------------------------------
    if (!trailerState.acquire(key)) {
      logger.debug(
        `[Trailer] SKIP "${movie.name}" - already in-flight (another process holds the lock)`
      );
      return {
        trailer: null,
        status: 'SKIPPED',
        saved: false,
        retryAt: null,
        source: null,
        skipped: true,
        skipReason: 'IN_FLIGHT',
      };
    }

    // From here: lock held => MUST release in finally
    try {
      trailerState.markProcessed(key);
      return await this._processTrailer(movie, key);
    } finally {
      trailerState.release(key);
    }
  }

  /**
   * Real trailer processing logic (lock held + guards passed).
   *
   * RULES (yêu cầu #1, #5, #6, #7):
   *   - YouTube ONLY. No other fallback (especially NOT TMDB).
   *   - YouTube FOUND => save to `Movie.trailer` + log "YouTube trailer found"
   *     + log "Trailer saved to Movie" BEFORE log "Created/Updated movie".
   *   - YouTube RATE_LIMITED (429 / QUOTA_EXCEEDED / CIRCUIT_OPEN / TIMEOUT / ERROR) =>
   *     trailer stays untouched, retryAt set, movie import does NOT fail.
   *     Movie marked `trailerJobStatus='RATE_LIMITED'` for batch retry.
   *   - YouTube NOT_FOUND (queries exhausted + YouTube healthy) =>
   *     `trailerJobStatus='NOT_FOUND'` set, trailer field stays null in DB.
   *
   * ⭐ BUGFIX (yêu cầu #1):
   *   markNotFound is ONLY called when status === 'NOT_FOUND' (i.e. all queries
   *   exhausted + YouTube healthy). All other statuses (RATE_LIMITED, ERROR,
   *   TIMEOUT) call markRateLimited instead. trailer field is NEVER set to null.
   *
   * @private
   */
  async _processTrailer(movie, key) {
    // -----------------------------------------------------------------
    // SOURCE 1 (ONLY): YouTube
    // -----------------------------------------------------------------
    const youtube = await this.search(movie);

    if (youtube.status === 'FOUND' && youtube.trailer) {
      // Requirement #7: save trailer to MongoDB FIRST, then log "Trailer saved to Movie"
      // BEFORE log "Created/Updated movie".
      const saved = await this.saveTrailer(movie._id, youtube.trailer);
      trailerState.clearCooldown(key);
      logger.info(
        `[Trailer] ✅ FOUND: YouTube trailer ${youtube.trailer.key} ` +
        `("${youtube.trailer.name}") for "${movie.name}"`
      );
      logger.info(
        `[Trailer] ✅ Trailer saved to Movie ${movie._id || movie.slug} (key=${youtube.trailer.key})`
      );
      return {
        trailer: youtube.trailer,
        status: 'FOUND',
        saved,
        retryAt: null,
        source: 'youtube',
      };
    }

    // -----------------------------------------------------------------
    // ⭐ YouTube RATE_LIMITED / TIMEOUT / CIRCUIT_OPEN / QUOTA_EXCEEDED =>
    //   trailer stays UNTOUCHED in DB, retryAt set, NO TMDB call.
    //   This includes the 'search()' pre-check (when circuit is open at start)
    //   and the throw path (when YouTube returns 429 mid-query).
    // -----------------------------------------------------------------
    if (youtube.status === 'RATE_LIMITED') {
      const retryAt =
        youtube.retryAt || new Date(Date.now() + DEFAULT_RETRY_AFTER_MS);
      await this.markRateLimited(movie._id, retryAt, youtube.code);
      trailerState.setCooldown(key, retryAt, youtube.code || 'YOUTUBE_RATE_LIMITED');
      logger.warn(
        `[Trailer] ⏸ RETRY_PENDING for "${movie.name}" — code=${youtube.code || 'RATE_LIMITED'}, ` +
        `retry at ${retryAt.toISOString()}. ` +
        `trailer field UNCHANGED in DB.`
      );
      return {
        trailer: null,
        status: 'RATE_LIMITED',
        code: youtube.code || 'RATE_LIMITED',
        saved: false,
        retryAt,
        source: null,
      };
    }

    // -----------------------------------------------------------------
    // ⭐ YouTube ERROR (already mapped to RATE_LIMITED in search() for safety).
    // This branch is kept as a defensive guard for any future 'ERROR' status.
    // -----------------------------------------------------------------
    if (youtube.status === 'ERROR') {
      const retryAt = new Date(Date.now() + DEFAULT_RETRY_AFTER_MS);
      await this.markRateLimited(movie._id, retryAt, 'ERROR');
      trailerState.setCooldown(key, retryAt, 'ERROR');
      logger.warn(
        `[Trailer] ⏸ RETRY_PENDING (ERROR) for "${movie.name}" — ` +
        `retry at ${retryAt.toISOString()}. ` +
        `trailer field UNCHANGED in DB.`
      );
      return { trailer: null, status: 'RATE_LIMITED', code: 'ERROR', saved: false, retryAt, source: null };
    }

    // -----------------------------------------------------------------
    // YouTube truly has no trailer (NOT_FOUND) => trailer stays null,
    // movie import does NOT fail. No other fallback (yêu cầu #1, #6).
    // ⭐ This is the ONLY path that calls markNotFound.
    // -----------------------------------------------------------------
    await this.markNotFound(movie._id);
    trailerState.clearCooldown(key);
    logger.info(
      `[Trailer] ⬜ NOT_FOUND for "${movie.name}" — YouTube healthy, ` +
      `all queries exhausted, no trailer on YouTube. ` +
      `Marked trailerJobStatus='NOT_FOUND' (will NOT be retried).`
    );
    return { trailer: null, status: 'NOT_FOUND', saved: false, retryAt: null, source: null };
  }

  /**
   * Save a real trailer (with key) into `Movie.trailer` as an OBJECT.
   *
   * SAFETY: NEVER overwrite an existing valid trailer (race with batch jobs).
   * If the "only write when missing" filter does not match, we re-check: if the
   * movie truly has none (filter mismatch), write directly to avoid losing data.
   * NEVER sets null.
   *
   * @returns {Promise<boolean>} true if written to DB
   */
  async saveTrailer(movieId, trailer) {
    if (!trailer || !trailer.key) {
      logger.debug('[Trailer] saveTrailer skipped - no key provided');
      return false;
    }
    if (!movieId) {
      logger.warn('[Trailer] saveTrailer skipped - missing movieId');
      return false;
    }

    const url = trailer.url || `https://www.youtube.com/watch?v=${trailer.key}`;
    const doc = {
      name: trailer.name || '',
      key: trailer.key,
      site: trailer.site || 'YouTube',
      type: trailer.type || 'Trailer',
      official: !!trailer.official,
      publishedAt: trailer.publishedAt || null,
      url,
      updatedAt: trailer.updatedAt || new Date(),
      viewCount: trailer.viewCount ?? 0,
    };

    try {
      // Only write when movie has no valid trailer (avoid racing other batch jobs).
      const result = await Movie.updateOne(
        {
          _id: movieId,
          $or: [
            { trailer: { $exists: false } },
            { trailer: null },
            { 'trailer.key': { $exists: false } },
            { 'trailer.key': null },
            { 'trailer.key': '' },
          ],
        },
        {
          $set: {
            trailer: doc,
            'tmdb.trailer_url': url,
            trailerJobStatus: 'OK',
            trailerRetryAt: null,
          },
        }
      );

      if (result.matchedCount > 0) {
        return true;
      }

      // matchedCount === 0 => check if movie already has a valid trailer.
      const existing = await Movie.findOne({ _id: movieId }).select('trailer').lean();
      if (existing?.trailer?.key) {
        logger.debug(
          `[Trailer] saveTrailer skipped for movie ${movieId} - existing valid trailer preserved`
        );
        return false;
      }

      // Movie truly has no trailer (filter mismatch) => write directly.
      await Movie.updateOne(
        { _id: movieId },
        {
          $set: {
            trailer: doc,
            'tmdb.trailer_url': url,
            trailerJobStatus: 'OK',
            trailerRetryAt: null,
          },
        }
      );
      return true;
    } catch (error) {
      logger.error(`[Trailer] Failed to save trailer: ${error.message}`);
      return false;
    }
  }

  /**
   * ⭐ Mark job as RATE_LIMITED (queued for retry).
   * Trailer field in DB stays UNTOUCHED — only `trailerJobStatus` and
   * `trailerRetryAt` are set. The batch job will pick this up again after
   * `trailerRetryAt` elapses.
   *
   * ⭐ BUGFIX (yêu cầu #1, #6): trailer field is NEVER set to null here.
   * Only the status flag + retry timestamp are updated.
   *
   * @param {string|ObjectId} movieId
   * @param {Date} retryAt
   * @param {string} [code]  diagnostic only, not persisted (e.g. 'CIRCUIT_OPEN', 'TIMEOUT', 'QUOTA_EXCEEDED', 'ERROR')
   */
  async markRateLimited(movieId, retryAt, code = 'RATE_LIMITED') {
    try {
      await Movie.updateOne(
        { _id: movieId },
        {
          $set: {
            trailerJobStatus: 'RATE_LIMITED',
            trailerRetryAt: retryAt || new Date(Date.now() + DEFAULT_RETRY_AFTER_MS),
          },
        }
      );
    } catch (error) {
      logger.error(`[Trailer] Failed to mark RATE_LIMITED: ${error.message}`);
    }
  }

  /**
   * ⭐ Mark NOT_FOUND — ONLY call this when YouTube is healthy AND all
   * configured queries returned empty. trailer field stays null in DB
   * (i.e. unset or `null` from initial schema state, never actively set).
   */
  async markNotFound(movieId) {
    try {
      await Movie.updateOne(
        { _id: movieId },
        {
          $set: {
            trailerJobStatus: 'NOT_FOUND',
            trailerRetryAt: null,
          },
        }
      );
    } catch (error) {
      logger.error(`[Trailer] Failed to mark NOT_FOUND: ${error.message}`);
    }
  }

  /**
   * Fetch + update trailer for one movie by slug (admin endpoint).
   * Uses `force: true` because this is an explicit request - bypass dedupe window.
   */
  async fetchAndUpdateTrailer(slug) {
    try {
      const movie = await Movie.findOne({ slug });
      if (!movie) {
        return { success: false, message: `Movie not found: ${slug}` };
      }

      const result = await this.getTrailer(movie, { force: true });
      return {
        success: result.status === 'FOUND',
        message:
          result.status === 'FOUND'
            ? `Trailer saved for: ${movie.name} (source=${result.source})`
            : result.status === 'SKIPPED'
              ? `Skipped: ${movie.name} (${result.skipReason || 'dedupe/in-flight'})`
              : `No trailer (status=${result.status}) for: ${movie.name}`,
        trailer: result.trailer,
        status: result.status,
        source: result.source,
      };
    } catch (error) {
      logger.error(`[Trailer] fetchAndUpdateTrailer failed for ${slug}: ${error.message}`);
      return { success: false, message: error.message, trailer: null };
    }
  }

  /**
   * Batch retry trailers for movies without one (or RATE_LIMITED past cooldown).
   *
   * ⭐ SEQUENTIAL + BATCH + DELAY + COOLDOWN (requirement #1-#11)
   *
   *   - Movies are processed SEQUENTIALLY (no parallel API calls).
   *   - Pool is split into batches of `batchSize` movies.
   *   - Between movies in the SAME batch: random delay
   *     `[movieDelayMinMs, movieDelayMaxMs]` ms (default 3-8s).
   *   - Between batches: sleep `batchPauseMs` (default 60s).
   *   - On YouTube 429/RATE_LIMITED: stop the CURRENT batch, enter COOLDOWN for
   *     `rateLimitCooldownMs` (default 30 min), then resume processing the
   *     remaining unprocessed movies.
   *   - Movies with a valid trailer (key/url) are NEVER re-processed.
   *   - Movies marked `trailerJobStatus='NOT_FOUND'` are skipped to save quota.
   *   - On server restart: only movies WITHOUT a valid trailer AND with
   *     `trailerRetryAt <= now` (or unset) are picked up (handled by the query).
   *   - Trailer is stored in `Movie.trailer` (nested object, NO Trailer collection).
   *
   * @param {number|Object} [optsOrLimit=50]
   *   - For backward-compat: a number is treated as the OLD `limit` (max movies).
   *   - Recommended: an options object:
   *       {
   *         batchSize,            // 10|20|30|40 (default from config / 10)
   *         batchPauseMs,         // default 60_000
   *         movieDelayMinMs,      // default 3_000
   *         movieDelayMaxMs,      // default 8_000
   *         rateLimitCooldownMs,  // default 30 * 60_000
   *         limit,                // max movies to process this run (0 = no cap)
   *       }
   * @returns {Promise<Object>} stats
   */
  async batchUpdateTrailers(optsOrLimit = {}) {
    // -------------------------------------------------------------------------
    // Backward-compat: numeric arg => legacy `limit` (max movies)
    // Object arg     => new options (batchSize, batchPauseMs, ...)
    // -------------------------------------------------------------------------
    let opts;
    if (typeof optsOrLimit === 'number') {
      opts = { limit: optsOrLimit };
    } else {
      opts = optsOrLimit || {};
    }

    // Load defaults from config
    const cfg = config.trailerBatch || {};

    // Validate batchSize: only {10, 20, 30, 40} allowed; else fallback to 10.
    const rawBatchSize = Number.isFinite(opts.batchSize) ? opts.batchSize : cfg.batchSize;
    const batchSize = ALLOWED_BATCH_SIZES.includes(rawBatchSize) ? rawBatchSize : 10;
    if (!ALLOWED_BATCH_SIZES.includes(rawBatchSize)) {
      logger.warn(
        `[Trailer] Invalid batchSize=${rawBatchSize}; only ${ALLOWED_BATCH_SIZES.join(', ')} are ` +
        `allowed. Falling back to batchSize=10.`
      );
    }

    const batchPauseMs = Number.isFinite(opts.batchPauseMs)
      ? opts.batchPauseMs
      : (cfg.batchPauseMs ?? 60_000);
    const movieDelayMinMs = Number.isFinite(opts.movieDelayMinMs)
      ? opts.movieDelayMinMs
      : (cfg.movieDelayMinMs ?? 3_000);
    const movieDelayMaxMs = Number.isFinite(opts.movieDelayMaxMs)
      ? opts.movieDelayMaxMs
      : (cfg.movieDelayMaxMs ?? 8_000);
    const rateLimitCooldownMs = Number.isFinite(opts.rateLimitCooldownMs)
      ? opts.rateLimitCooldownMs
      : (cfg.rateLimitCooldownMs ?? 30 * 60_000);
    const maxMovies = Number.isFinite(opts.limit) && opts.limit > 0
      ? opts.limit
      : (cfg.maxMoviesPerRun ?? 200);

    logger.info(
      `[Trailer] 🚀 Starting SEQUENTIAL batch trailer job ` +
      `(batchSize=${batchSize}, batchPauseMs=${batchPauseMs}, ` +
      `movieDelay=${movieDelayMinMs}-${movieDelayMaxMs}ms, ` +
      `rateLimitCooldownMs=${rateLimitCooldownMs}, maxMovies=${maxMovies})`
    );

    // Prune stale state to avoid memory leaks.
    trailerState.prune();

    // YouTube circuit is OPEN at start => defer entire batch.
    if (rateLimiter.isCircuitOpen()) {
      const remaining = Math.round(this._circuitRemainingMs() / 1000);
      logger.warn(
        `[Trailer] YouTube circuit OPEN - batch deferred ` +
        `(~${remaining}s remaining).`
      );
      return {
        total: 0, found: 0, rateLimited: 0, notFound: 0,
        errors: 0, skipped: 0, cooldowns: 0,
        batches: 0, batchesPlanned: 0,
        deferred: true,
      };
    }

    // -------------------------------------------------------------------------
    // QUERY: movies that need (re-)processing
    //   - No valid trailer (key missing/null/empty)
    //   - AND NOT in permanent NOT_FOUND (save YouTube quota)
    //   - AND RATE_LIMITED only if `trailerRetryAt <= now`
    //
    // Movies already with a valid trailer are NEVER returned by this query.
    // Movies with `trailerJobStatus=NOT_FOUND` are excluded to preserve quota.
    // -------------------------------------------------------------------------
    const now = new Date();
    const baseFilter = {
      $or: [
        { trailer: null },
        { trailer: { $exists: false } },
        { 'trailer.key': { $exists: false } },
        { 'trailer.key': null },
        { 'trailer.key': '' },
        { trailerJobStatus: 'RATE_LIMITED', trailerRetryAt: { $lte: now } },
      ],
      trailerJobStatus: { $ne: 'NOT_FOUND' },
    };

    const candidateCount = await Movie.countDocuments(baseFilter);
    const effectiveLimit = Math.min(maxMovies, candidateCount);
    const movies = await Movie.find(baseFilter)
      .select('_id name year releaseDate originName trailer trailerJobStatus trailerRetryAt dateLastMain')
      // Newest-first: most likely to have fresh YouTube data, but RATE_LIMITED
      // ones (whose cooldown has expired) will be interleaved.
      .sort({ dateLastMain: -1, _id: -1 })
      .limit(effectiveLimit)
      .lean();

    // Deduplicate by _id (paranoia).
    const seen = new Set();
    const pool = [];
    for (const m of movies) {
      const id = String(m._id);
      if (seen.has(id)) continue;
      seen.add(id);
      pool.push(m);
    }

    if (pool.length === 0) {
      logger.info(`[Trailer] ✅ Nothing to do: 0 candidates (all have valid trailers or are NOT_FOUND).`);
      return {
        total: 0, found: 0, rateLimited: 0, notFound: 0,
        errors: 0, skipped: 0, cooldowns: 0,
        batches: 0, batchesPlanned: 0,
        candidatesInDb: candidateCount,
      };
    }

    const totalBatches = Math.ceil(pool.length / batchSize);
    logger.info(
      `[Trailer] 📦 Pool: ${pool.length} movies (candidates in DB: ${candidateCount}, ` +
      `maxMovies cap: ${effectiveLimit}). Planned batches: ${totalBatches}.`
    );

    let found = 0, rateLimited = 0, notFound = 0, errors = 0, skipped = 0, cooldowns = 0;

    // -------------------------------------------------------------------------
    // MAIN LOOP: walk through batches, then movies inside each batch, SEQUENTIALLY.
    // -------------------------------------------------------------------------
    for (let b = 0; b < totalBatches; b++) {
      const batchStart = b * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, pool.length);
      const batch = pool.slice(batchStart, batchEnd);
      const batchNo = b + 1;

      logger.info(
        `[Trailer] 📦 Batch ${batchNo}/${totalBatches} START ` +
        `(movies ${batchStart + 1}..${batchEnd}/${pool.length})`
      );

      let batchAborted = false;

      for (let i = 0; i < batch.length; i++) {
        const m = batch[i];
        const idxInBatch = i + 1;
        const idxOverall = batchStart + i + 1;
        const remaining = pool.length - idxOverall;

        // Per-movie banner log (requirement #9)
        logger.info(
          `[Trailer] 🎬 [Batch ${batchNo}/${totalBatches}] ` +
          `Movie ${idxInBatch}/${batch.length} (overall ${idxOverall}/${pool.length}) ` +
          `→ "${m.name}" | Remaining: ${remaining}`
        );

        // Defensive: skip movies that already have a valid trailer
        // (could have been populated between query time and now).
        if (
          m.trailer &&
          ((m.trailer.key && String(m.trailer.key).trim() !== '') ||
            (m.trailer.url && String(m.trailer.url).trim() !== ''))
        ) {
          skipped++;
          logger.info(
            `[Trailer] ⏭ [Batch ${batchNo}/${totalBatches}] ` +
            `"${m.name}" — already has valid trailer, skipping.`
          );
          continue;
        }

        // Defensive: respect retryAt if a new RATE_LIMITED was set after query.
        if (
          m.trailerJobStatus === 'RATE_LIMITED' &&
          m.trailerRetryAt &&
          new Date(m.trailerRetryAt).getTime() > Date.now()
        ) {
          skipped++;
          logger.info(
            `[Trailer] ⏭ [Batch ${batchNo}/${totalBatches}] ` +
            `"${m.name}" — retry scheduled at ${new Date(m.trailerRetryAt).toISOString()}, skipping.`
          );
          continue;
        }

        try {
          const result = await this.getTrailer(m);

          if (result.status === 'FOUND') {
            found++;
            logger.info(
              `[Trailer] ✅ [Batch ${batchNo}/${totalBatches}] ` +
              `${idxInBatch}/${batch.length} — "${m.name}" FOUND ` +
              `(key=${result.trailer?.key || '-'}, source=${result.source || '-'}) | ` +
              `Remaining: ${remaining}`
            );
          } else if (result.status === 'RATE_LIMITED') {
            rateLimited++;
            batchAborted = true;
            const cdSec = Math.round(rateLimitCooldownMs / 1000);
            const untilIso = new Date(Date.now() + rateLimitCooldownMs).toISOString();
            logger.warn(
              `[Trailer] ⏸ [Batch ${batchNo}/${totalBatches}] ` +
              `${idxInBatch}/${batch.length} — "${m.name}" RATE_LIMITED (code=${result.code || 'COOLDOWN'}). ` +
              `STOPPING BATCH → COOLDOWN for ${cdSec}s (until ${untilIso}). ` +
              `Movie queued for RETRY (DB trailerJobStatus='RATE_LIMITED'). ` +
              `Will resume remaining ${remaining} movies after cooldown.`
            );

            await this._cooldownSleep(
              rateLimitCooldownMs,
              () => rateLimiter.isReady() && !rateLimiter.isCircuitOpen(),
              (leftMs) => {
                logger.info(
                  `[Trailer] 💤 COOLDOWN — ${Math.round(leftMs / 1000)}s remaining ` +
                  `(circuit=${rateLimiter.cb?.state || 'unknown'})`
                );
              }
            );
            cooldowns++;
            break; // break the inner loop; outer loop will continue with next batch
          } else if (result.status === 'NOT_FOUND') {
            notFound++;
            logger.info(
              `[Trailer] ⬜ [Batch ${batchNo}/${totalBatches}] ` +
              `${idxInBatch}/${batch.length} — "${m.name}" NOT_FOUND ` +
              `(YouTube healthy, all queries exhausted, no trailer). ` +
              `DB marked trailerJobStatus='NOT_FOUND'. Remaining: ${remaining}`
            );
          } else if (result.status === 'SKIPPED') {
            skipped++;
            logger.info(
              `[Trailer] ⏭ [Batch ${batchNo}/${totalBatches}] ` +
              `${idxInBatch}/${batch.length} — "${m.name}" SKIPPED ` +
              `(${result.skipReason || 'dedupe/in-flight/cooldown'}). ` +
              `Remaining: ${remaining}`
            );
          } else {
            errors++;
            logger.warn(
              `[Trailer] ❌ [Batch ${batchNo}/${totalBatches}] ` +
              `${idxInBatch}/${batch.length} — "${m.name}" UNKNOWN status=${result.status}. ` +
              `Remaining: ${remaining}`
            );
          }
        } catch (err) {
          errors++;
          logger.warn(
            `[Trailer] ❌ [Batch ${batchNo}/${totalBatches}] ` +
            `${idxInBatch}/${batch.length} — "${m.name}" EXCEPTION: ${err.message}`
          );
        }

        // Inter-movie delay (within batch): random [min, max] ms.
        // Only sleep if not the LAST movie of the batch AND batch wasn't aborted.
        if (i < batch.length - 1 && !batchAborted) {
          const span = Math.max(0, movieDelayMaxMs - movieDelayMinMs);
          const delayMs = movieDelayMinMs + Math.floor(Math.random() * (span + 1));
          logger.debug(
            `[Trailer] ⏱ Inter-movie delay: ${Math.round(delayMs / 1000)}s ` +
            `(random in [${movieDelayMinMs}, ${movieDelayMaxMs}]ms)`
          );
          await _sleep(delayMs);
        }
      }

      // After batch: either aborted (already cooled down) or finished cleanly.
      if (batchAborted) {
        logger.warn(
          `[Trailer] 🛑 Batch ${batchNo}/${totalBatches} ABORTED due to RATE_LIMITED. ` +
          `Resuming next batch after cooldown.`
        );
      } else {
        logger.info(
          `[Trailer] 🏁 Batch ${batchNo}/${totalBatches} COMPLETE ` +
          `(found=${found}, rateLimited=${rateLimited}, notFound=${notFound}, ` +
          `errors=${errors}, skipped=${skipped}).`
        );
        // Inter-batch pause (skip if this is the last batch).
        if (b < totalBatches - 1) {
          logger.info(
            `[Trailer] 💤 Inter-batch pause: ${Math.round(batchPauseMs / 1000)}s ` +
            `before batch ${batchNo + 1}/${totalBatches}...`
          );
          await _sleep(batchPauseMs);
        }
      }
    }

    const stats = {
      total: pool.length,
      candidatesInDb: candidateCount,
      found,
      rateLimited,
      notFound,
      errors,
      skipped,
      cooldowns,
      batches: totalBatches,
      batchesPlanned: totalBatches,
    };
    logger.info(`[Trailer] ✅ Batch update complete: ${JSON.stringify(stats)}`);
    return stats;
  }

  /**
   * Sleep for up to `ms` milliseconds, BUT exit early if `shouldExit()` returns true.
   * Periodically calls `onTick(leftMs)` for the caller to log progress.
   *
   * Used for the RATE_LIMITED cooldown (requirement #6):
   *   - Default sleep: `rateLimitCooldownMs` (30 min)
   *   - Exit early if YouTube circuit becomes ready (HALF_OPEN/CLOSED)
   *
   * @private
   */
  async _cooldownSleep(ms, shouldExit, onTick) {
    const tickMs = 30_000; // log every 30s
    const deadline = Date.now() + ms;
    let nextLog = Date.now() + tickMs;

    while (Date.now() < deadline) {
      if (typeof shouldExit === 'function' && shouldExit()) {
        logger.info('[Trailer] 🟢 Cooldown ended early — circuit ready.');
        return;
      }
      const left = deadline - Date.now();
      if (Date.now() >= nextLog && typeof onTick === 'function') {
        onTick(left);
        nextLog = Date.now() + tickMs;
      }
      await _sleep(Math.min(5_000, Math.max(500, left)));
    }
    if (typeof onTick === 'function') onTick(0);
  }

    /** Count movies with a real trailer (key non-empty). */
  async countWithTrailer() {
    return Movie.countDocuments({ 'trailer.key': { $exists: true, $ne: '' } });
  }

  /** Trailer pipeline overview for debugging. */
  async getStats() {
    const [withTrailer, total, rateLimited, notFound] = await Promise.all([
      this.countWithTrailer(),
      Movie.countDocuments({}),
      Movie.countDocuments({ trailerJobStatus: 'RATE_LIMITED' }),
      Movie.countDocuments({ trailerJobStatus: 'NOT_FOUND' }),
    ]);
    return {
      total,
      withTrailer,
      withoutTrailer: total - withTrailer,
      coverage: total > 0 ? ((withTrailer / total) * 100).toFixed(2) + '%' : '0%',
      rateLimited,
      notFound,
      youtube: {
        enabled: YouTubeService.enabled,
        available: YouTubeService.isAvailable(),
        circuitOpen: rateLimiter.isCircuitOpen(),
        circuitRemainingMs: this._circuitRemainingMs(),
      },
      state: trailerState.stats(),
    };
  }
}

module.exports = new TrailerService();