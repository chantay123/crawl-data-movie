/**
 * YouTube Service - Trailer search (YouTube Data API v3) — NGUỒN DUY NHẤT cho trailer.
 *
 * Responsibilities:
 *   - Search movie trailers on YouTube Data API v3 `search.list`
 *   - Respect global rate limiter + circuit breaker (utils/youtubeRateLimiter)
 *   - Stop IMMEDIATELY on 429 / quotaExceeded (don't try other queries)
 *   - Preserve Vietnamese diacritics in queries
 *   - Never crash the caller on quota/rate-limit/network failure
 *
 * ⭐ NGUỒN TRAILER DUY NHẤT — KHÔNG có TMDB fallback (yêu cầu #1).
 *   Khi YouTube lỗi → `trailer = null` + `trailerJobStatus='RATE_LIMITED'` + retry sau.
 *
 * Errors thrown are tagged with `.code` for the caller to handle:
 *   - 'RATE_LIMITED'    → 429 from YouTube
 *   - 'QUOTA_EXCEEDED'  → 403 dailyQuotaExceeded / quotaExceeded
 *   - 'CIRCUIT_OPEN'    → local circuit breaker tripped
 *   - 'TIMEOUT'         → request exceeded YOUTUBE_REQUEST_TIMEOUT_MS
 *   - 'API_ERROR'       → 4xx/5xx (non-429) - non-retryable
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

    // maxResults nhỏ, ưu tiên 5 (yêu cầu #2)
    this.maxResults = config.youtube.maxResults ?? 5;
    // CHỈ 2 query: "<title> official trailer" rồi "<title> trailer" (yêu cầu #2)
    this.maxQueries = parseInt(process.env.YOUTUBE_MAX_QUERIES || '2', 10);
    // Cap retries for 429 separately — don't hammer a rate-limited API.
    this.rateLimitMaxRetries = parseInt(
      process.env.YOUTUBE_RATE_LIMIT_MAX_RETRIES || '0', 10
    );
    this.requestTimeoutMs = parseInt(
      process.env.YOUTUBE_REQUEST_TIMEOUT_MS || '10000', 10
    );

    if (!this.enabled) {
      logger.warn('[YouTube] Service disabled. Set ENABLE_YOUTUBE_TRAILER=true and YOUTUBE_API_KEY');
    } else {
      const st = rateLimiter.status();
      logger.info(
        `[YouTube] ✅ Initialised (SOLE trailer source) ` +
        `(queries=${this.maxQueries}, maxResults=${this.maxResults}, ` +
        `concurrency=${st.concurrency}, cbThreshold=${rateLimiter.cb.failureThreshold}, ` +
        `cbCooldown=${Math.round(rateLimiter.cb.cooldownMs / 1000)}s)`
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

  /**
   * Phát hiện lỗi HẾT QUOTA của YouTube Data API.
   *
   * YouTube trả HTTP 403 với `reason: 'quotaExceeded' | 'dailyLimitExceeded'`
   * (body.error.errors[].reason hoặc error.message chứa chuỗi này).
   * Đây KHÔNG phải lỗi tạm thời kiểu 429 — quota hồi lại lúc 00:00 PT,
   * nên cần cooldown dài hơn hẳn để tránh spam vô ích.
   *
   * @param {Error} err
   * @returns {boolean}
   */
  _isQuotaExceeded(err) {
    const status = err?.response?.status;
    if (status !== 403 && status !== 429) return false;

    const reasons = [];
    const errReasons = err?.response?.data?.error?.errors;
    if (Array.isArray(errReasons)) {
      for (const e of errReasons) if (e?.reason) reasons.push(String(e.reason));
    }
    if (err?.response?.data?.error?.status) reasons.push(String(err.response.data.error.status));
    const msg = String(err?.response?.data?.error?.message || err?.message || '');
    if (msg) reasons.push(msg);

    return reasons.some((r) =>
      /quotaexceeded|dailylimitexceeded|rateLimitExceeded|quota/i.test(r)
    );
  }

  /**
   * Cooldown cho lỗi hết quota (tính tới nửa đêm PT theo giờ Pacific).
   * YouTube reset quota lúc 00:00 America/Los_Angeles.
   * @returns {number} ms
   */
  _quotaResetDelayMs() {
    try {
      // offset giờ mùa hè của PT = UTC-7
      const now = new Date();
      const PT_OFFSET_MS = 7 * 60 * 60 * 1000;
      const ptNow = new Date(now.getTime() + PT_OFFSET_MS);
      // đặt PT về 00:00 ngày mai
      const nextReset = Date.UTC(
        ptNow.getUTCFullYear(),
        ptNow.getUTCMonth(),
        ptNow.getUTCDate() + 1,
        0, 0, 0
      ) - PT_OFFSET_MS;
      // tối thiểu 15 phút để không busy-loop nếu clock lệch
      return Math.max(15 * 60 * 1000, nextReset - now.getTime());
    } catch (_) {
      return 60 * 60 * 1000; // 1h
    }
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

        // ⭐ HẾT QUOTA (403 quotaExceeded / dailyLimitExceeded) — KHÔNG phải 429.
        // Cooldown tới lúc YouTube reset quota (00:00 PT), tuyệt đối không retry.
        if (this._isQuotaExceeded(err)) {
          const quotaDelay = this._quotaResetDelayMs();
          rateLimiter.recordFailure({
            status: 429,
            retryAfterMs: quotaDelay,
            quotaExceeded: true,
          });
          const e = new Error(
            `[YouTube] QUOTA_EXCEEDED for "${context}" — ` +
            `no quota until ${new Date(Date.now() + quotaDelay).toISOString()}`
          );
          e.code = 'QUOTA_EXCEEDED';
          e.status = status || 403;
          e.quotaExceeded = true;
          e.retryAfterMs = quotaDelay;
          throw e;
        }

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
   * ⭐ KHÔNG BAO GIỜ retry trong các trường hợp (yêu cầu #6):
   *   - QUOTA_EXCEEDED → không retry (quota hồi 00:00 PT)
   *   - RATE_LIMITED   → không retry (mặc định rateLimitMaxRetries = 0)
   *   - CIRCUIT_OPEN   → không retry (breaker đã quyết định)
   *
   * Chỉ retry cho lỗi rẻ: TIMEOUT / 5xx (network blip).
   *
   * Throws the LAST error if all attempts fail.
   */
  async _executeWithRetry(context, requestFn) {
    let lastError = null;

    for (let attempt = 1; attempt <= rateLimiter.maxRetries; attempt++) {
      try {
        return await this._callYouTube(context, requestFn);
      } catch (err) {
        lastError = err;

        // QUOTA_EXCEEDED → tuyệt đối không retry
        if (err.code === 'QUOTA_EXCEEDED') {
          logger.warn(
            `[YouTube] 🚫 QUOTA_EXCEEDED on "${context}" — NOT retrying. ` +
            `Quota resets at ${new Date(Date.now() + (err.retryAfterMs || 0)).toISOString()}.`
          );
          throw err;
        }

        // Circuit is OPEN → no point retrying, the breaker is already tripped.
        if (err.code === 'CIRCUIT_OPEN') {
          throw err;
        }

        // 429 → allow at most rateLimitMaxRetries retries (mặc định 0 = không retry)
        if (err.code === 'RATE_LIMITED' && attempt > this.rateLimitMaxRetries) {
          logger.warn(
            `[YouTube] 🚫 429 on "${context}" — NOT retrying ` +
            `(rateLimitMaxRetries=${this.rateLimitMaxRetries}).`
          );
          throw err;
        }

        const isLast = attempt >= rateLimiter.maxRetries;
        const isRetryable = err.code === 'RATE_LIMITED'
          || err.code === 'TIMEOUT'
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
   *
   * ⭐ CHỈ 2 QUERY, theo đúng thứ tự yêu cầu (mỗi query = 1 quota unit):
   *   1. "<title> official trailer"
   *   2. "<title> trailer"
   *
   * KHÔNG dùng bare title nữa vì quá rộng, dễ trả về clip/OST không phải trailer.
   * `maxQueries` mặc định = 2 (xem constructor), có thể override qua env
   * `YOUTUBE_MAX_QUERIES` nhưng vẫn tôn trọng thứ tự trên.
   *
   * @param {string} movieName   Vietnamese title (diacritics preserved)
   * @param {number|string|null} year  release year (không dùng trong query hiện tại)
   * @param {string} [originName] original title fallback
   * @returns {string[]}
   */
  _buildQueries(movieName, year, originName) {
    const title = (movieName || '').trim();
    const origin = (originName || '').trim();
    const maxQueries = this.maxQueries || 2;

    /** @type {string[]} */
    const candidates = [];

    const push = (q) => {
      if (q && q.trim()) candidates.push(q.trim());
    };

    // ── Thứ tự BẮT BUỘC (yêu cầu #2) ──
    if (title) {
      push(`${title} official trailer`); // 1
      push(`${title} trailer`);          // 2
    }

    // Fallback: originalTitle (chỉ dùng nếu khác title VÀ còn budget query)
    if (origin && origin.toLowerCase() !== title.toLowerCase()) {
      push(`${origin} official trailer`);
      push(`${origin} trailer`);
    }

    // De-duplicate (case-insensitive) preserving order
    const seen = new Set();
    const queries = [];
    for (const q of candidates) {
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(q);
    }

    // Cap the number of queries to protect the API quota
    const capped = queries.slice(0, maxQueries);
    if (queries.length > capped.length) {
      logger.debug(
        `[YouTube] Query list capped: ${capped.length}/${queries.length} ` +
        `(maxQueries=${maxQueries}) for "${title}"`
      );
    }
    return capped;
  }

  /**
   * Is YouTube usable right now (service enabled AND no circuit/cooldown)?
   * TrailerService dùng để quyết định có gọi YouTube hay không.
   * @returns {boolean}
   */
  isAvailable() {
    return this.enabled && rateLimiter.isReady();
  }

  /**
   * Search for a movie trailer on YouTube Data API v3.
   *
   * ⭐ NGUỒN TRAILER DUY NHẤT — không có fallback.
   *
   * Hợp đồng trả về:
   *   - FOUND          → trailer object
   *   - KHÔNG tìm thấy  → null (CHỈ khi đã thử hết query và tất cả đều rỗng)
   *   - Bị chặn        → THROW error có `.code`:
   *       'RATE_LIMITED'   → 429
   *       'QUOTA_EXCEEDED' → hết quota (403 quotaExceeded)
   *       'CIRCUIT_OPEN'   → circuit breaker của limiter đang mở
   *     kèm `.retryAfterMs`
   *
   * Lý do throw thay vì return null: caller (TrailerService) cần phân biệt
   * "movie này thật sự không có trailer" với "YouTube đang bị rate-limit".
   * Nếu return null, movie sẽ bị đánh dấu NOT_FOUND vĩnh viễn (trailer = null).
   *
   * @param {string} movieName      Vietnamese title (diacritics preserved)
   * @param {number|string|null} year  release year (best-effort)
   * @param {string} [originName]   original title fallback
   * @returns {Promise<Object|null>}
   * @throws  {Error} .code = 'RATE_LIMITED' | 'QUOTA_EXCEEDED' | 'CIRCUIT_OPEN' | 'API_ERROR'
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

      // Pre-check: circuit OPEN / cooldown → THROW (không return null) để caller biết
      // đây là tạm thời → giữ trailer=null và retry sau (yêu cầu #6).
      if (!rateLimiter.isReady()) {
        const isOpen = rateLimiter.isCircuitOpen();
        const remainingMs = rateLimiter.readyInMs();
        logger.warn(
          `[YouTube] ⛔ Unavailable (${isOpen ? 'CIRCUIT_OPEN' : 'COOLDOWN'}) — ` +
          `stopping at query ${i + 1}/${queries.length} for "${movieName}" ` +
          `(~${Math.round(remainingMs / 1000)}s remaining).`
        );
        const e = new Error(
          `[YouTube] ${isOpen ? 'CIRCUIT_OPEN' : 'RATE_LIMITED'} ` +
          `for "${movieName}" (query ${i + 1}/${queries.length})`
        );
        e.code = isOpen ? 'CIRCUIT_OPEN' : 'RATE_LIMITED';
        e.retryAfterMs = remainingMs;
        throw e;
      }

      try {
        logger.debug(`[YouTube] Query ${i + 1}/${queries.length}: "${query}"`);

        const response = await this._executeWithRetry(
          query,
          () => axios.get(`${this.baseUrl}/search`, {
            params: {
              part: 'snippet',
              q: query,
              type: 'video',            // yêu cầu #2
              maxResults: this.maxResults, // ưu tiên 5
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

        const trailerTitle = best.snippet?.title || '';
        const trailerType = this._detectType(trailerTitle); // 'Trailer' | 'Teaser'
        const trailer = {
          name: trailerTitle,
          key: best.id.videoId,
          site: 'YouTube',
          type: trailerType,
          official: this._isOfficialTrailer(trailerTitle, best.snippet?.channelTitle),
          publishedAt: best.snippet?.publishedAt || null,
          url: `https://www.youtube.com/watch?v=${best.id.videoId}`,
          updatedAt: new Date(),
          viewCount: 0
        };

        logger.info(`[YouTube] ✅ FOUND ${trailerType}: "${trailer.name}" (key=${trailer.key}) for "${movieName}"`);
        return trailer;
      } catch (err) {
        // CRITICAL: stop trying more queries on quota/rate-limit/circuit-open.
        // Re-throw so the caller keeps trailer=null and retries later.
        if (
          err.code === 'RATE_LIMITED' ||
          err.code === 'QUOTA_EXCEEDED' ||
          err.code === 'CIRCUIT_OPEN'
        ) {
          logger.warn(
            `[YouTube] ⛔ ${err.code} — STOPPING further queries for "${movieName}" ` +
            `(after ${i + 1}/${queries.length}).`
          );
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

    logger.info(
      `[YouTube] ⬜ NOT FOUND — no trailer after ${queries.length} queries for "${movieName}" ` +
      `(queries exhausted, not a rate-limit issue)`
    );
    return null;
  }

  /**
   * Phân loại video theo title (yêu cầu #3): 'Trailer' hoặc 'Teaser'.
   * "official teaser" / "teaser" → Teaser; còn lại → Trailer.
   * @param {string} title
   * @returns {'Trailer'|'Teaser'}
   */
  _detectType(title) {
    const t = (title || '').toLowerCase();
    // Nếu có "trailer" → Trailer (ưu tiên cao hơn teaser)
    if (t.includes('trailer')) return 'Trailer';
    if (t.includes('teaser')) return 'Teaser';
    return 'Trailer';
  }

  // =================================================================
  // Filtering / ranking
  // =================================================================

  /**
   * ⭐ Lọc kết quả (yêu cầu #3): chỉ giữ video có title chứa MỘT trong:
   *   'official trailer' | 'trailer' | 'official teaser' | 'teaser'
   * (khớp không phân biệt hoa thường). Đồng thời loại rác (VEVO, lyric, OST...).
   *
   * @returns {boolean} true nếu video đủ điều kiện làm trailer
   */
  _isPlausibleVideo(item, movieName) {
    const title = (item.snippet?.title || '').toLowerCase();
    const channel = (item.snippet?.channelTitle || '').toLowerCase();

    // ── Loại rác TRƯỚC (rẻ hơn, và tránh false positive) ──
    if (channel.includes('vevo')) return false;
    if (title.includes('music video')) return false;
    if (title.includes('lyric')) return false;
    if (title.includes('tv spot') || title.includes('tv clip')) return false;
    if (title.includes('review') || title.includes('reaction')) return false;
    if (title.includes('ost') && !title.includes('trailer')) return false;

    // ── BẮT BUỘC có từ khóa trailer/teaser (yêu cầu #3) ──
    const hasKeyword =
      title.includes('official trailer') ||
      title.includes('trailer') ||
      title.includes('official teaser') ||
      title.includes('teaser');
    if (!hasKeyword) return false;

    // Phải có ít nhất 1 từ đáng kể trùng với tên phim (an toàn, hợp diacritics VN)
    const tokens = this._significantTokens(movieName);
    if (tokens.length >= 2 && !tokens.some((t) => title.includes(t))) {
      return false;
    }
    return true;
  }

  _significantTokens(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 3);
  }

  /**
   * ⭐ Chọn video TỐT NHẤT theo thứ tự ưu tiên (yêu cầu #4):
   *   1. Official trailer   (official=true  + type=Trailer)
   *   2. Trailer            (type=Trailer)
   *   3. Teaser             (official=true  + type=Teaser)
   *   4. Teaser             (type=Teaser)
   *
   * Trong cùng một bậc, điểm bổ sung quyết định (tên khớp phim, kênh official, HD, mới).
   *
   * @param {Array} items - các item đã lọc qua _isPlausibleVideo
   * @param {string} movieName
   * @returns {Object|null}
   */
  _findBestTrailer(items, movieName) {
    const norm = (movieName || '').toLowerCase();
    let best = null;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestScore = -Infinity;

    for (const item of items) {
      const title = (item.snippet?.title || '').toLowerCase();
      const channel = (item.snippet?.channelTitle || '').toLowerCase();

      const isTrailer = title.includes('trailer');
      const isTeaser = title.includes('teaser');
      const isOfficial = this._isOfficialTrailer(title, channel);

      // ── RANK theo yêu cầu #4 (0 = tốt nhất) ──
      let rank;
      if (isTrailer && isOfficial) rank = 0;       // Official trailer
      else if (isTrailer) rank = 1;                // Trailer
      else if (isTeaser && isOfficial) rank = 2;   // Official teaser
      else rank = 3;                               // Teaser

      // ── Điểm phụ (chỉ dùng để chọn trong cùng rank) ──
      let score = 0;
      if (norm && title.includes(norm)) score += 10;
      if (title.includes('official')) score += 2;
      if (channel.includes('official')) score += 2;
      if (title.includes('hd') || title.includes('full')) score += 1;
      if (title.includes('clip') && !isTrailer && !isTeaser) score -= 5;

      // Ưu tiên video mới hơn (giảm nhẹ)
      const publishedRaw = item.snippet?.publishedAt;
      if (publishedRaw) {
        const publishedAt = new Date(publishedRaw);
        const ms = publishedAt.getTime();
        if (!Number.isNaN(ms)) {
          const daysOld = (Date.now() - ms) / (1000 * 60 * 60 * 24);
          if (daysOld > 730) score -= 1;
        }
      }

      if (best === null || rank < bestRank || (rank === bestRank && score > bestScore)) {
        bestRank = rank;
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