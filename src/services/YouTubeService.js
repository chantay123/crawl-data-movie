/**
 * YouTube Service - Trailer search with hardened rate limiting
 *
 * Responsibilities:
 *   - Search movie trailers on YouTube Data API v3
 *   - Respect global rate limiter + circuit breaker (utils/youtubeRateLimiter)
 *   - Stop IMMEDIATELY on 429 (don't try other queries)
 *   - Preserve Vietnamese diacritics in queries
 *   - Never crash the caller on quota/rate-limit/network failure
 *
 * Errors thrown are tagged with `.code` for the caller to handle:
 *   - 'RATE_LIMITED'   → 429 from YouTube
 *   - 'CIRCUIT_OPEN'   → local circuit breaker tripped
 *   - 'TIMEOUT'        → request exceeded YOUTUBE_REQUEST_TIMEOUT_MS
 *   - 'API_ERROR'      → 4xx/5xx (non-429) - non-retryable
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const rateLimiter = require('../utils/youtubeRateLimiter');

class YouTubeService {
  constructor() {
    this.apiKey = config.youtube.apiKey;
    this.baseUrl = 'https://www.googleapis.com/youtube/v3';
    this.enabled = config.youtube.enabled && !!this.apiKey;

    this.maxResults = config.youtube.maxResults ?? 5;
    this.requestTimeoutMs = parseInt(
      process.env.YOUTUBE_REQUEST_TIMEOUT_MS || '10000', 10
    );

    if (!this.enabled) {
      logger.warn('[YouTube] Service disabled. Set ENABLE_YOUTUBE_TRAILER=true and YOUTUBE_API_KEY');
    } else {
      const st = rateLimiter.status();
      logger.info(
        `[YouTube] ✅ Initialised with hardened rate limiting ` +
        `(concurrency=${st.concurrency}, cbThreshold=${rateLimiter.cb.failureThreshold})`
      );
    }
  }

  /** Sleep helper. */
  _sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(r => setTimeout(r, ms));
  }

  /** Map a network/timeout/HTTP error to a tagged error with `.code`. */
  _tagError(err, context) {
    if (err && err.code && ['RATE_LIMITED', 'CIRCUIT_OPEN', 'TIMEOUT', 'API_ERROR'].includes(err.code)) {
      return err;
    }
    const status = err.response?.status;
    const code = err.code || (status === 429 ? 'RATE_LIMITED' : status ? 'API_ERROR' : 'NETWORK');
    const e = new Error(
      `[YouTube] ${code} for "${context}": ${err.message}` +
      (status ? ` (status=${status})` : '')
    );
    e.code = code;
    e.status = status || null;
    e.original = err;
    e.retryAfterMs = this._getRetryAfterDelay(err);
    return e;
  }

  /** Extract Retry-After (in ms). Accepts delta-seconds or HTTP-date. */
  _getRetryAfterDelay(error) {
    const header = error.response?.headers?.['retry-after'];
    if (!header) return null;
    const num = parseInt(header, 10);
    if (!isNaN(num) && num >= 0) return num * 1000;
    const dateMs = Date.parse(header);
    if (!isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
    return null;
  }

  /** Detect whether an HTTP status code is "transient" (worth reporting as failure). */
  _isTransientStatus(status) {
    return status === 429 || (status >= 500 && status < 600);
  }

  /**
   * Make a single YouTube API call through the global rate limiter.
   * Throws tagged errors (RATE_LIMITED, CIRCUIT_OPEN, TIMEOUT, API_ERROR).
   */
  async _callYouTube(context, requestFn) {
    if (rateLimiter.isCircuitOpen()) {
      const e = new Error(`[YouTube] Circuit breaker OPEN, refusing "${context}"`);
      e.code = 'CIRCUIT_OPEN';
      throw e;
    }

    await rateLimiter.acquire();
    try {
      let response;
      try {
        response = await requestFn();
      } catch (err) {
        // Map common axios errors to tagged errors
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
          const e = new Error(`[YouTube] timeout for "${context}"`);
          e.code = 'TIMEOUT';
          rateLimiter.recordOutcome({ status: null, code: 'ETIMEDOUT' });
          throw e;
        }

        const status = err.response?.status;
        const retryAfterMs = this._getRetryAfterDelay(err);

        if (status === 429) {
          rateLimiter.recordOutcome({ status: 429, retryAfterMs });
          const e = new Error(
            `[YouTube] RATE_LIMITED for "${context}"` +
            (retryAfterMs ? ` (Retry-After=${Math.round(retryAfterMs / 1000)}s)` : '')
          );
          e.code = 'RATE_LIMITED';
          e.status = 429;
          e.retryAfterMs = retryAfterMs;
          throw e;
        }

        if (this._isTransientStatus(status)) {
          rateLimiter.recordOutcome({ status });
          const e = new Error(`[YouTube] ${status} for "${context}"`);
          e.code = 'API_ERROR';
          e.status = status;
          throw e;
        }

        if (status) {
          // Non-transient 4xx (400, 401, 403, 404) - don't touch breaker
          const e = new Error(`[YouTube] ${status} for "${context}": ${err.message}`);
          e.code = 'API_ERROR';
          e.status = status;
          throw e;
        }

        // Network error
        rateLimiter.recordOutcome({ code: err.code || 'ENETWORK' });
        const e = new Error(`[YouTube] network error for "${context}": ${err.message}`);
        e.code = 'API_ERROR';
        throw e;
      }

      rateLimiter.recordSuccess();
      return response;
    } finally {
      rateLimiter.release();
    }
  }

  /**
   * Retry a request function with bounded retries using the rate limiter's
   * exponential backoff + jitter + Retry-After-aware cooldown.
   *
   * Only retries on RATE_LIMITED / TIMEOUT / transient (5xx) errors.
   * Throws the LAST error if all attempts fail.
   */
  async _executeWithRetry(context, requestFn) {
    let lastError = null;

    for (let attempt = 1; attempt <= rateLimiter.maxRetries; attempt++) {
      try {
        return await this._callYouTube(context, requestFn);
      } catch (err) {
        lastError = err;

        const isLast = attempt >= rateLimiter.maxRetries;
        const isRetryable = err.code === 'RATE_LIMITED'
          || err.code === 'TIMEOUT'
          || err.code === 'CIRCUIT_OPEN'
          || (err.code === 'API_ERROR' && this._isTransientStatus(err.status));

        if (!isRetryable || isLast) {
          throw err;
        }

        const delay = rateLimiter.nextBackoff(attempt);
        logger.warn(
          `[YouTube] Attempt ${attempt}/${rateLimiter.maxRetries} failed (${err.code}) ` +
          `for "${context}". Waiting ${Math.round(delay / 1000)}s before retry...`
        );
        await this._sleep(delay);
      }
    }
    throw lastError;
  }

  /**
   * Build the list of search queries to try for a movie.
   * IMPORTANT: Vietnamese diacritics are preserved - no NFD normalization here.
   */
  _buildQueries(movieName, year, originName) {
    const title = (movieName || '').trim();
    const origin = (originName || '').trim();
    const queries = [];

    // Priority 1: Vietnamese title + "official trailer"
    queries.push(`${title} official trailer`);
    // Priority 2: Vietnamese title + "trailer"
    queries.push(`${title} trailer`);
    // Priority 3: Vietnamese title + "phim trailer"
    queries.push(`${title} phim trailer`);

    // Origin name fallbacks (preserved Vietnamese)
    if (origin && origin !== title) {
      queries.push(`${origin} official trailer`);
      queries.push(`${origin} trailer`);
    }

    // Optional year qualifier (best-effort, appended to the front later)
    return queries;
  }

  /**
   * Search for a movie trailer on YouTube.
   *
   * @param {string} movieName      Vietnamese title (diacritics preserved)
   * @param {number|string|null} year  release year (best-effort)
   * @param {string} [originName]   original title fallback
   * @returns {Promise<Object|null>}  trailer object or null
   */
  async searchTrailer(movieName, year = null, originName = null) {
    if (!this.enabled) {
      logger.debug('[YouTube] Service disabled, skipping');
      return null;
    }
    if (!movieName) return null;

    const queries = this._buildQueries(movieName, year, originName);
    if (queries.length === 0) return null;

    logger.info(`[YouTube] Searching trailer: "${movieName}" (${queries.length} queries)`);

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];

      // Pre-check: if circuit is OPEN, bail immediately for all remaining queries.
      if (rateLimiter.isCircuitOpen()) {
        logger.warn(`[YouTube] ⛔ Circuit OPEN — stopping at query ${i + 1}/${queries.length}`);
        return null;
      }

      try {
        logger.debug(`[YouTube] Query ${i + 1}/${queries.length}: "${query}"`);

        const response = await this._executeWithRetry(
          query,
          () => axios.get(`${this.baseUrl}/search`, {
            params: {
              part: 'snippet',
              q: query,
              type: 'video',
              videoDuration: 'short',
              maxResults: this.maxResults,
              key: this.apiKey,
            },
            timeout: this.requestTimeoutMs,
          })
        );

        const items = response.data?.items || [];
        if (items.length === 0) {
          logger.debug(`[YouTube] No results for "${query}"`);
          continue;
        }

        const filtered = items.filter(item => this._isPlausibleVideo(item, movieName));
        if (filtered.length === 0) {
          logger.debug(`[YouTube] All results filtered out for "${query}"`);
          continue;
        }

        const best = this._findBestTrailer(filtered, movieName);
        if (!best) {
          logger.debug(`[YouTube] No best trailer in results for "${query}"`);
          continue;
        }

        const trailer = {
          name: best.snippet.title,
          key: best.id.videoId,
          site: 'YouTube',
          type: 'Trailer',
          official: this._isOfficialTrailer(best.snippet.title, best.snippet.channelTitle),
          publishedAt: best.snippet.publishedAt || null,
          url: `https://www.youtube.com/watch?v=${best.id.videoId}`,
          updatedAt: new Date(),
          viewCount: 0
        };

        logger.info(`[YouTube] ✅ Found trailer: ${trailer.name} (${trailer.key})`);
        return trailer;
      } catch (err) {
        // CRITICAL: stop trying more queries on rate-limit / circuit-open / global cooldown.
        if (err.code === 'RATE_LIMITED' || err.code === 'CIRCUIT_OPEN') {
          logger.warn(`[YouTube] ⛔ ${err.code} — STOPPING further queries for "${movieName}"`);
          throw err;
        }
        if (err.code === 'TIMEOUT') {
          logger.warn(`[YouTube] ⏱ Timeout for "${query}" — trying next`);
          continue;
        }
        if (err.code === 'API_ERROR') {
          // 4xx/5xx → log and continue to next query (unless it's a transient 5xx, already retried)
          logger.warn(`[YouTube] ${err.status || err.code} for "${query}": ${err.message}`);
          continue;
        }
        logger.warn(`[YouTube] Unexpected error for "${query}": ${err.message}`);
        continue;
      }
    }

    logger.info(`[YouTube] No trailer found after ${queries.length} queries for: ${movieName}`);
    return null;
  }

  // =================================================================
  // Filtering / scoring (unchanged from original)
  // =================================================================

  _isPlausibleVideo(item, movieName) {
    const title = (item.snippet?.title || '').toLowerCase();
    const channel = (item.snippet?.channelTitle || '').toLowerCase();

    if (title.includes('music video')) return false;
    if (title.includes('lyric')) return false;
    if (title.includes('ost') && !title.includes('trailer')) return false;
    if (channel.includes('vevo')) return false;
    if (channel.includes('music')) return false;
    if (title.includes('tv spot')) return false;
    if (title.includes('tv clip')) return false;

    // Must share at least one significant word with the movie title (Vietnamese-safe)
    const tokens = this._significantTokens(movieName);
    if (tokens.length >= 2) {
      const hasMatch = tokens.some(t => title.includes(t));
      if (!hasMatch) return false;
    }
    return true;
  }

  _significantTokens(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length >= 3);
  }

  _findBestTrailer(items, movieName) {
    const norm = (movieName || '').toLowerCase();
    let bestScore = -Infinity;
    let best = null;

    for (const item of items) {
      const title = (item.snippet?.title || '').toLowerCase();
      const channel = (item.snippet?.channelTitle || '').toLowerCase();
      let score = 0;

      if (norm && title.includes(norm)) score += 10;
      if (title.includes('official trailer')) score += 6;
      else if (title.includes('trailer')) score += 3;
      if (title.includes('official')) score += 2;
      if (channel.includes('official')) score += 2;
      if (title.includes('hd')) score += 1;

      // Penalize non-trailer content
      if (title.includes('teaser') && !title.includes('trailer')) score -= 3;
      if (title.includes('clip') && !title.includes('trailer')) score -= 2;
      if (title.includes('review')) score -= 4;
      if (title.includes('reaction')) score -= 4;

      // Penalize old videos
      const publishedAt = new Date(item.snippet?.publishedAt || 0);
      const daysOld = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld > 365) score -= 1;

      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  _isOfficialTrailer(title, channelTitle) {
    const t = (title || '').toLowerCase();
    const c = (channelTitle || '').toLowerCase();
    if (t.includes('official')) return true;
    return /(official|movieclips|trailer|universal|warner|paramount|disney|marvel|sony|fox|lionsgate)/i.test(c);
  }
}

module.exports = new YouTubeService();