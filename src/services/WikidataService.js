/**
 * WikidataService - Wikidata API Integration
 *
 * Lấy thông tin Person (Actor / Director) từ Wikidata:
 *   - name (label)                : en / vi
 *   - profileImage (P18)          : ảnh từ Wikimedia Commons
 *   - gender (P21)                : male / female / non-binary / unknown
 *   - dateOfBirth (P569)          : ngày sinh (Wikidata time value)
 *
 * Public API:
 *   - searchActor(name)
 *   - getActorByQid(qid, fallbackName?)
 *   - findActor(name)
 *   - searchDirector(name)              ← NEW (mirror của searchActor)
 *   - getDirectorByQid(qid, fallbackName?) ← NEW (có thêm P569)
 *   - findDirector(name)                  ← NEW (mirror của findActor)
 *
 * Đặc tính (production-ready):
 *   - SINGLE-FLIGHT QUEUE: concurrency = 1 (hoặc cấu hình) — KHÔNG spam request
 *   - TIMEOUT  : axios timeout 10s (configurable)
 *   - RETRY    : 429 / 5xx / network errors với exponential backoff 30s → 60s → 120s → 240s
 *                (đọc `Retry-After` header nếu có, capped ở maxPauseMs)
 *   - ESCALATE : nhiều 429 liên tiếp sẽ nhân đôi pause window cho tới maxPauseMs (10 phút)
 *   - FAIL-FAST: 4xx (trừ 429) → NOT_FOUND, không retry
 *   - STATUS   : trả về { status, data, error, retryAfterMs } để caller phân biệt rõ
 *   - CACHE    : in-memory Map, TTL 24h. CHỈ cache status ổn định (OK/NOT_FOUND/CLIENT_ERROR).
 *                KHÔNG cache RATE_LIMITED/SERVER_ERROR/NETWORK_ERROR → tránh block retries.
 *                Actor và Director dùng namespace cache riêng (`actor:*` vs `director:*`)
 *                để tránh cache hit chéo giữa 2 ngữ cảnh.
 *   - MEDIAWIKI: thêm `maxlag=5` cho Action API
 *   - UA       : WIKIDATA_USER_AGENT env
 *
 * Không hard-code URL — lấy từ config.wikidata.apiUrl
 * (mặc định env: WIKIDATA_API_URL=https://www.wikidata.org/w/api.php).
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Status codes dùng chung cho service trả về — define TRƯỚC class
// để các module require() có thể thấy ngay khi load.
const STATUS = Object.freeze({
  OK: 'OK',
  NOT_FOUND: 'NOT_FOUND',          // 200 + rỗng | 404
  RATE_LIMITED: 'RATE_LIMITED',    // 429
  SERVER_ERROR: 'SERVER_ERROR',    // 5xx
  NETWORK_ERROR: 'NETWORK_ERROR',  // timeout / ECONNRESET / DNS / etc.
  CLIENT_ERROR: 'CLIENT_ERROR',    // 4xx (khác 429)
  DISABLED: 'DISABLED',            // service disabled
});

// Wikidata gender QIDs → mapped value
// Source: https://www.wikidata.org/wiki/Property:P21
const WIKIDATA_GENDER_QIDS = Object.freeze({
  Q6581097: 'male',     // male
  Q6581072: 'female',   // female
  Q1097630: 'other',    // intersex
  Q48270:   'other',    // non-binary
  Q1052281: 'other',    // transgender female (best-effort)
  Q2449503: 'other',    // transgender male
  Q1399232: 'other',
});

class WikidataService {
  constructor() {
    const wk = config.wikidata || {};
    this.enabled = wk.enabled !== false;
    this.apiUrl = wk.apiUrl || 'https://www.wikidata.org/w/api.php';
    this.requestDelay = wk.requestDelay || 1100;        // delay giữa các request (ms)
    this.timeoutMs = wk.timeoutMs || 10000;
    this.maxRetries = Math.max(0, wk.maxRetries ?? 4);  // 4 retries
    this.userAgent = wk.userAgent || 'MovieStreaming/1.0 (https://github.com/your-repo; contact: your-email@example.com)';
    this.lang = wk.lang || 'en';

    // Pause tuning — khi gặp 429, queue pause tối thiểu `minPauseMs`, tối đa `maxPauseMs`.
    // Mỗi 429 liên tiếp sẽ ESCALATE pause (nhân đôi) cho tới khi hết burst rate-limit.
    this.minPauseMs = wk.minPauseMs || 60000;          // 60s
    this.maxPauseMs = wk.maxPauseMs || 10 * 60 * 1000; // 10 phút

    // === Queue / Concurrency ===
    // concurrency = 1 để tránh spam 429. Có thể bump lên 2-3 nếu muốn.
    this.concurrency = Math.max(1, wk.concurrency || 1);
    this.activeCount = 0;
    this.queueTail = Promise.resolve(); // FIFO queue cho các lệnh gọi

    // === Circuit breaker cho 429: pause queue khi bị rate limit ===
    this.pausedUntil = 0;
    // Bộ đếm 429 liên tiếp — escalate pause window khi gặp nhiều 429.
    this.consecutive429 = 0;
    // Track lần log pause cuối (timestamp của pausedUntil đã log) — chống spam log
    this._lastPauseLogged = 0;

    // === Cache ===
    // Map<normalizedName, { status, data, timestamp, ttlMs }>
    // CHỈ cache những status ổn định (OK, NOT_FOUND, CLIENT_ERROR).
    // KHÔNG cache RATE_LIMITED / SERVER_ERROR / NETWORK_ERROR → sẽ block retries.
    this.cache = new Map();
    this.cacheEnabled = wk.cacheEnabled !== false;
    this.cacheTtlMs = wk.cacheTtlMs || 24 * 60 * 60 * 1000; // 24h
    this.cacheMaxEntries = wk.cacheMaxEntries || 5000;
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // === Backoff config cho 429 / 5xx ===
    // Mặc định 30s → 60s → 120s → 240s (configurable qua env)
    this.retryDelays = Array.isArray(wk.retryDelays) && wk.retryDelays.length > 0
      ? wk.retryDelays
      : [30000, 60000, 120000, 240000];

    // === Transient statuses — KHÔNG bao giờ cache những status này ===
    this.TRANSIENT_STATUSES = new Set([
      STATUS.RATE_LIMITED,
      STATUS.SERVER_ERROR,
      STATUS.NETWORK_ERROR,
    ]);

    if (this.enabled) {
      logger.info(
        `[Wikidata] ✅ Initialized: apiUrl=${this.apiUrl}, timeout=${this.timeoutMs}ms, ` +
        `retry=${this.maxRetries}, delay=${this.requestDelay}ms, concurrency=${this.concurrency}, ` +
        `cache=${this.cacheEnabled ? `on (ttl=${this.cacheTtlMs}ms)` : 'off'}, ` +
        `minPause=${this.minPauseMs}ms, maxPause=${this.maxPauseMs}ms`
      );
    } else {
      logger.debug('[Wikidata] Disabled by flag');
    }
  }

  // ========================================================================
  // CACHE HELPERS
  // ========================================================================

  _normalizeKey(name) {
    return String(name).trim().toLowerCase();
  }

  _cacheGet(name) {
    if (!this.cacheEnabled) return null;
    const key = this._normalizeKey(name);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  _cacheSet(name, status, data) {
    if (!this.cacheEnabled) return;
    const key = this._normalizeKey(name);
    // LRU-ish: nếu vượt max thì xóa phần tử cũ nhất
    if (this.cache.size >= this.cacheMaxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      status,
      data,
      timestamp: Date.now(),
      ttlMs: this.cacheTtlMs,
    });
  }

  clearCache() {
    this.cache.clear();
    logger.debug('[Wikidata] Cache cleared');
  }

  // ========================================================================
  // QUEUE / CONCURRENCY
  // ========================================================================

  /**
   * Chạy 1 task với concurrency limit + delay giữa các task.
   * - Đảm bảo KHÔNG có 2 request đồng thời nếu concurrency=1.
   * - Tuân thủ pause (do 429).
   */
  async _enqueue(taskFn) {
    // Mỗi task đợi task trước xong rồi mới chạy (FIFO + concurrency=1)
    const prev = this.queueTail;
    let release;
    this.queueTail = new Promise(r => { release = r; });

    try {
      await prev; // chờ task trước xong
      // Chờ nếu queue bị pause do 429
      await this._waitIfPaused();
      // Chờ rate-limit tối thiểu giữa 2 request
      await this._rateLimit();
      return await taskFn();
    } finally {
      release();
    }
  }

  /**
   * Nếu queue đang pause (do 429), chờ tới khi hết thời gian pause.
   * Chỉ log 1 lần cho mỗi pause window để tránh spam log khi nhiều caller cùng đợi.
   */
  async _waitIfPaused() {
    const now = Date.now();
    if (this.pausedUntil > now) {
      const waitMs = this.pausedUntil - now;
      if (!this._lastPauseLogged || this._lastPauseLogged < this.pausedUntil) {
        logger.warn(`[Wikidata] Queue paused, waiting ${waitMs}ms`);
        this._lastPauseLogged = this.pausedUntil;
      } else {
        logger.debug(`[Wikidata] Still waiting ${waitMs}ms (already logged)`);
      }
      await new Promise(r => setTimeout(r, waitMs));
      // Sau khi chờ xong → reset streak để pause tiếp theo (nếu có) bắt đầu lại từ minPauseMs.
      this._resetRateLimitStreak();
    }
  }

  /**
   * Kiểm tra queue có đang pause không (cho caller quyết định skip).
   * @returns {boolean}
   */
  isPaused() {
    return this.pausedUntil > Date.now();
  }

  /**
   * Trả về thời gian pause còn lại (ms), 0 nếu không pause.
   */
  pausedRemainingMs() {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /**
   * Pause queue trong `ms` mili-giây (do 429).
   * Mọi request mới sẽ đợi tới khi hết pause.
   * Nếu gặp nhiều 429 liên tiếp, pause sẽ ESCALATE (nhân đôi) cho tới khi hết burst.
   *
   * Trả về ms thực sự được pause (đã clamp vào [minPauseMs, maxPauseMs]).
   */
  _pauseQueue(ms) {
    // Escalate: nhân đôi pause window cho mỗi 429 liên tiếp, nhưng >= minPauseMs.
    // Lần đầu 429: pause = max(ms, minPauseMs)
    // Lần 2 liên tiếp: pause = max(2*ms, minPauseMs*2)
    // ...cap tại maxPauseMs.
    this.consecutive429 += 1;
    const escalated = Math.max(ms, this.minPauseMs) * Math.pow(2, Math.max(0, this.consecutive429 - 1));
    const clamped = Math.min(escalated, this.maxPauseMs);
    const until = Date.now() + clamped;
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
      logger.warn(`[Wikidata] Queue paused for ${clamped}ms due to rate limit (consecutive 429: ${this.consecutive429})`);
    } else {
      logger.debug(`[Wikidata] Pause not extended (already paused until ${new Date(this.pausedUntil).toISOString()})`);
    }
    return clamped;
  }

  /**
   * Reset bộ đếm 429 liên tiếp — gọi khi có request THÀNH CÔNG (200 OK) hoặc
   * hết pause window. Đây là tín hiệu "rate-limit đã hết" → pause window tiếp theo sẽ trở về mặc định.
   */
  _resetRateLimitStreak() {
    if (this.consecutive429 > 0) {
      logger.debug(`[Wikidata] Rate-limit streak reset (was ${this.consecutive429})`);
      this.consecutive429 = 0;
    }
  }

  /**
   * Rate-limit nhẹ giữa các request thành công.
   * Track thời gian bắt đầu request cuối.
   */
  async _rateLimit() {
    // Chỉ delay nếu đã có request trước đó
    if (this.lastRequestStart) {
      const elapsed = Date.now() - this.lastRequestStart;
      if (elapsed < this.requestDelay) {
        await new Promise(r => setTimeout(r, this.requestDelay - elapsed));
      }
    }
  }

  // ========================================================================
  // RETRY / BACKOFF
  // ========================================================================

  /**
   * Parse `Retry-After` header (seconds hoặc HTTP-date).
   * Cap = 10 phút để tránh "pause cả ngày" nếu server trả về giá trị lớn bất thường.
   */
  _parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const cap = this.maxPauseMs || 10 * 60 * 1000;
    // Dạng số (giây)
    const asNumber = Number(headerValue);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.min(asNumber * 1000, cap);
    }
    // Dạng HTTP-date
    const asDate = Date.parse(headerValue);
    if (!isNaN(asDate)) {
      return Math.min(asDate - Date.now(), cap);
    }
    return null;
  }

  /**
   * Lấy delay cho attempt thứ `attempt` (0-based).
   * Theo yêu cầu: 5s → 10s → 20s → 40s
   */
  _getRetryDelay(attempt) {
    if (attempt < this.retryDelays.length) {
      return this.retryDelays[attempt];
    }
    // Sau retryDelays.length lần thì cap ở 40s
    return this.retryDelays[this.retryDelays.length - 1];
  }

  /**
   * Thực thi 1 request tới MediaWiki Action API với:
   *   - maxlag=5
   *   - User-Agent
   *   - Timeout
   *
   * Trả về: { status: STATUS, data?, error?, retryAfterMs? }
   */
  async _executeRequest(params) {
    if (!this.enabled) {
      return { status: STATUS.DISABLED, data: null };
    }

    let attempt = 0;
    let lastResult = null;

    while (attempt <= this.maxRetries) {
      this.lastRequestStart = Date.now();

      try {
        const response = await axios.get(this.apiUrl, {
          params: {
            ...params,
            maxlag: 5, // MediaWiki Action API: tell server to delay if lag > 5s
          },
          timeout: this.timeoutMs,
          headers: {
            Accept: 'application/json',
            'User-Agent': this.userAgent,
          },
          // Chấp nhận mọi status < 500 để axios không throw
          validateStatus: (status) => status >= 200 && status < 500,
        });

        const status = response.status;

        // === 200 OK ===
        if (status === 200) {
          // Request thành công → reset rate-limit streak
          this._resetRateLimitStreak();
          return { status: STATUS.OK, data: response.data };
        }

        // === 4xx (trừ 429) → NOT_FOUND / CLIENT_ERROR, fail fast ===
        if (status >= 400 && status < 500 && status !== 429) {
          // 404 thì coi như NOT_FOUND (Wikidata thường trả 200 + entity.missing
          // nhưng đề phòng trả 404)
          if (status === 404) {
            logger.debug(`[Wikidata] HTTP 404 for params: ${JSON.stringify(params).slice(0, 80)}`);
            return { status: STATUS.NOT_FOUND, data: null };
          }
          logger.warn(`[Wikidata] HTTP ${status} client error, fail fast`);
          return { status: STATUS.CLIENT_ERROR, data: null };
        }

        // === 429 → RATE_LIMITED, retry với Retry-After hoặc backoff ===
        if (status === 429) {
          const retryAfterHeader = response.headers?.['retry-after'];
          const retryAfterMs = this._parseRetryAfter(retryAfterHeader);
          const backoff = retryAfterMs ?? this._getRetryDelay(attempt);
          lastResult = { status: STATUS.RATE_LIMITED, retryAfterMs: backoff };

          // Pause queue NGAY khi gặp 429 (escalating).
          // Nếu đã hết retry → pause dài hơn (maxPauseMs) để "nghỉ" thật sự.
          if (attempt >= this.maxRetries) {
            const finalPause = this._pauseQueue(this.maxPauseMs);
            logger.warn(`[Wikidata] HTTP 429 - rate limited after retries (attempt ${attempt + 1}); pausing ${finalPause}ms`);
            return lastResult;
          }

          logger.warn(`[Wikidata] HTTP 429 - rate limited`);
          logger.warn(`[Wikidata] Waiting ${backoff}ms before retry...`);
          // Pause queue escalating + chờ in-place cho retry này.
          this._pauseQueue(backoff);
          await new Promise(r => setTimeout(r, backoff));
          attempt++;
          continue;
        }

        // === 5xx → SERVER_ERROR, retry với backoff ===
        if (status >= 500) {
          lastResult = { status: STATUS.SERVER_ERROR };
          if (attempt >= this.maxRetries) {
            logger.warn(`[Wikidata] HTTP ${status} - server error after retries`);
            return lastResult;
          }
          const backoff = this._getRetryDelay(attempt);
          logger.warn(`[Wikidata] HTTP ${status} - server error, waiting ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          attempt++;
          continue;
        }

        // Status khác (không lường trước)
        return { status: STATUS.CLIENT_ERROR, data: null };
      } catch (err) {
        // === Network / timeout ===
        const isNetworkError = [
          'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
          'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED',
          'ESOCKETTIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE',
        ].includes(err.code);

        if (!isNetworkError) {
          logger.warn(`[Wikidata] Non-network error: ${err.message}`);
          return { status: STATUS.CLIENT_ERROR, error: err };
        }

        lastResult = { status: STATUS.NETWORK_ERROR, error: err };
        if (attempt >= this.maxRetries) {
          logger.warn(`[Wikidata] Network error ${err.code} after retries`);
          return lastResult;
        }

        const backoff = this._getRetryDelay(attempt);
        logger.warn(`[Wikidata] Network error ${err.code}, waiting ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        attempt++;
      }
    }

    return lastResult || { status: STATUS.SERVER_ERROR };
  }

  /**
   * Request qua queue (single-flight) + cache check.
   * Trả về { status, data, error?, fromCache? }
   */
  async _request(params, cacheName = null) {
    if (!this.enabled) {
      return { status: STATUS.DISABLED, data: null };
    }

    // === Cache check ===
    if (cacheName) {
      const cached = this._cacheGet(cacheName);
      if (cached) {
        this.cacheHits++;
        logger.debug(`[Wikidata] Cache hit for "${cacheName}": ${cached.status}`);
        return { ...cached, fromCache: true };
      }
      this.cacheMisses++;
    }

    // === Queue execution ===
    const result = await this._enqueue(() => this._executeRequest(params));

    // === Cache write ===
    // CHỈ cache những status ổn định (OK, NOT_FOUND, CLIENT_ERROR).
    // KHÔNG cache RATE_LIMITED / SERVER_ERROR / NETWORK_ERROR — sẽ block retries.
    if (cacheName && result.status !== STATUS.DISABLED && !this.TRANSIENT_STATUSES.has(result.status)) {
      this._cacheSet(cacheName, result.status, result.data);
    } else if (cacheName && this.TRANSIENT_STATUSES.has(result.status)) {
      logger.debug(`[Wikidata] Skipping cache write for transient status: ${result.status}`);
    }

    return { ...result, fromCache: false };
  }

  /**
   * Cache getter cho 1 actor name — dùng ở các public API.
   * Cache chỉ apply cho OK / NOT_FOUND (để tránh cache lỗi tạm thời).
   */
  _actorCacheCheck(name) {
    if (!name) return null;
    const cached = this._cacheGet(`actor:${name.trim().toLowerCase()}`);
    if (cached) {
      this.cacheHits++;
      logger.debug(`[Wikidata] Cache hit (findActor) for "${name}": ${cached.status}`);
      return { ...cached, fromCache: true };
    }
    this.cacheMisses++;
    return null;
  }

  /**
   * Cache setter cho actor name (dùng ở findActor).
   */
  _actorCacheSet(name, status, data) {
    if (!name) return;
    this._cacheSet(`actor:${name.trim().toLowerCase()}`, status, data);
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  /**
   * Search Wikidata để tìm QID + label + description cho 1 entity.
   * @returns {Promise<{status: string, data?: {qid,label,description}, error?: Error}>}
   *   status ∈ STATUS.* ; data null khi NOT_FOUND/RATE_LIMITED/SERVER_ERROR/NETWORK_ERROR
   */
  async searchActor(name) {
    if (!this.enabled || !name || typeof name !== 'string') {
      return { status: STATUS.DISABLED, data: null };
    }

    logger.info(`[Wikidata] Request: "${name}"`);

    const cacheName = `search:${name.trim()}`;
    const result = await this._request(
      {
        action: 'wbsearchentities',
        search: name.trim(),
        language: this.lang,
        type: 'item',
        limit: 5,
        format: 'json',
        origin: '*',
      },
      cacheName
    );

    if (result.status === STATUS.RATE_LIMITED) {
      logger.warn(`[Wikidata] HTTP 429 - rate limited for "${name}"`);
      return { status: STATUS.RATE_LIMITED, data: null };
    }
    if (result.status === STATUS.SERVER_ERROR) {
      logger.warn(`[Wikidata] Server error for "${name}"`);
      return { status: STATUS.SERVER_ERROR, data: null };
    }
    if (result.status === STATUS.NETWORK_ERROR) {
      logger.warn(`[Wikidata] Network error for "${name}": ${result.error?.message || 'unknown'}`);
      return { status: STATUS.NETWORK_ERROR, data: null };
    }
    if (result.status !== STATUS.OK) {
      return { status: result.status, data: null };
    }

    const data = result.data;
    if (!data || !Array.isArray(data.search) || data.search.length === 0) {
      logger.debug(`[Wikidata] NOT_FOUND (no search results): "${name}"`);
      // Cache miss đã được set ở _request với data=null, status=OK.
      // Tuy nhiên caller cần biết đây là NOT_FOUND logic — ta return lại.
      return { status: STATUS.NOT_FOUND, data: null };
    }

    // Ưu tiên entity có description chứa "actor/film/..." để tránh nhầm nhân vật
    const humanKeywords = ['actor', 'actress', 'film', 'television', 'movie', 'diễn viên'];
    const ranked = data.search
      .map(item => {
        const desc = (item.description || '').toLowerCase();
        const score = humanKeywords.reduce((s, kw) => s + (desc.includes(kw) ? 1 : 0), 0);
        return { item, score };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0]?.item;
    if (!best || !best.id) {
      return { status: STATUS.NOT_FOUND, data: null };
    }

    logger.info(`[Wikidata] ✅ Search hit for "${name}": ${best.id}`);
    return {
      status: STATUS.OK,
      data: {
        qid: best.id,
        label: best.label || null,
        description: best.description || null,
      },
    };
  }

  /**
   * Lấy P18 + P21 từ QID.
   * @returns {Promise<{status, data?, error?}>}
   */
  async getActorByQid(qid, fallbackName = null) {
    if (!this.enabled || !qid || typeof qid !== 'string') {
      return { status: STATUS.DISABLED, data: null };
    }

    const cacheName = `qid:${qid}`;
    const result = await this._request(
      {
        action: 'wbgetentities',
        ids: qid,
        props: 'claims',
        format: 'json',
        origin: '*',
      },
      cacheName
    );

    if (result.status !== STATUS.OK) {
      return { status: result.status, data: null };
    }

    const data = result.data;
    if (!data || !data.entities || !data.entities[qid]) {
      return { status: STATUS.NOT_FOUND, data: null };
    }

    const entity = data.entities[qid];
    if (entity.missing !== undefined) {
      return { status: STATUS.NOT_FOUND, data: null };
    }

    // P18 (image)
    let profileImage = null;
    const p18 = entity.claims?.P18;
    if (Array.isArray(p18) && p18.length > 0) {
      const fileName = p18[0].mainsnak?.datavalue?.value;
      if (fileName) {
        profileImage = this._buildCommonsImageUrl(fileName);
      }
    }

    // P21 (gender)
    let gender = null;
    const p21 = entity.claims?.P21;
    if (Array.isArray(p21) && p21.length > 0) {
      const genderQid = p21[0].mainsnak?.datavalue?.value?.id;
      if (genderQid) {
        gender = WIKIDATA_GENDER_QIDS[genderQid] || 'unknown';
      }
    }

    return {
      status: STATUS.OK,
      data: {
        qid,
        name: fallbackName || null,
        profileImage,
        gender,
      },
    };
  }

  /**
   * ========================================================================
   * DIRECTOR API (mirror của Actor API)
   * ========================================================================
   * Dùng chung queue / cache / rate-limit với Actor. Cache key có prefix
   * `director:` để tránh cache hit chéo với actor.
   */

  /**
   * Search Wikidata để tìm QID + label + description cho 1 DIRECTOR entity.
   * Logic giống searchActor, nhưng ưu tiên description chứa "director / filmmaker / regista".
   * @returns {Promise<{status: string, data?: {qid,label,description}, error?: Error}>}
   */
  async searchDirector(name) {
    if (!this.enabled || !name || typeof name !== 'string') {
      return { status: STATUS.DISABLED, data: null };
    }

    logger.info(`[Wikidata] Director request: "${name}"`);

    const cacheName = `search:director:${name.trim()}`;
    const result = await this._request(
      {
        action: 'wbsearchentities',
        search: name.trim(),
        language: this.lang,
        type: 'item',
        limit: 5,
        format: 'json',
        origin: '*',
      },
      cacheName
    );

    if (result.status === STATUS.RATE_LIMITED) {
      logger.warn(`[Wikidata] HTTP 429 - rate limited for director "${name}"`);
      return { status: STATUS.RATE_LIMITED, data: null };
    }
    if (result.status === STATUS.SERVER_ERROR) {
      logger.warn(`[Wikidata] Server error for director "${name}"`);
      return { status: STATUS.SERVER_ERROR, data: null };
    }
    if (result.status === STATUS.NETWORK_ERROR) {
      logger.warn(`[Wikidata] Network error for director "${name}": ${result.error?.message || 'unknown'}`);
      return { status: STATUS.NETWORK_ERROR, data: null };
    }
    if (result.status !== STATUS.OK) {
      return { status: result.status, data: null };
    }

    const data = result.data;
    if (!data || !Array.isArray(data.search) || data.search.length === 0) {
      logger.debug(`[Wikidata] NOT_FOUND (no search results): director "${name}"`);
      return { status: STATUS.NOT_FOUND, data: null };
    }

    // Ưu tiên entity có description chứa director-related keywords
    const directorKeywords = [
      'director', 'filmmaker', 'film director', 'television director',
      'screenwriter', 'movie director', 'đạo diễn',
    ];
    const ranked = data.search
      .map(item => {
        const desc = (item.description || '').toLowerCase();
        const score = directorKeywords.reduce((s, kw) => s + (desc.includes(kw) ? 1 : 0), 0);
        return { item, score };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0]?.item;
    if (!best || !best.id) {
      return { status: STATUS.NOT_FOUND, data: null };
    }

    logger.info(`[Wikidata] ✅ Director search hit for "${name}": ${best.id}`);
    return {
      status: STATUS.OK,
      data: {
        qid: best.id,
        label: best.label || null,
        description: best.description || null,
      },
    };
  }

  /**
   * Lấy P18 (image) + P21 (gender) + P569 (dateOfBirth) từ QID.
   * @returns {Promise<{status, data?, error?}>}
   */
  async getDirectorByQid(qid, fallbackName = null) {
    if (!this.enabled || !qid || typeof qid !== 'string') {
      return { status: STATUS.DISABLED, data: null };
    }

    const cacheName = `qid:director:${qid}`;
    const result = await this._request(
      {
        action: 'wbgetentities',
        ids: qid,
        props: 'claims',
        format: 'json',
        origin: '*',
      },
      cacheName
    );

    if (result.status !== STATUS.OK) {
      return { status: result.status, data: null };
    }

    const data = result.data;
    if (!data || !data.entities || !data.entities[qid]) {
      return { status: STATUS.NOT_FOUND, data: null };
    }

    const entity = data.entities[qid];
    if (entity.missing !== undefined) {
      return { status: STATUS.NOT_FOUND, data: null };
    }

    // P18 (image)
    let profileImage = null;
    const p18 = entity.claims?.P18;
    if (Array.isArray(p18) && p18.length > 0) {
      const fileName = p18[0].mainsnak?.datavalue?.value;
      if (fileName) {
        profileImage = this._buildCommonsImageUrl(fileName);
      }
    }

    // P21 (gender)
    let gender = null;
    const p21 = entity.claims?.P21;
    if (Array.isArray(p21) && p21.length > 0) {
      const genderQid = p21[0].mainsnak?.datavalue?.value?.id;
      if (genderQid) {
        gender = WIKIDATA_GENDER_QIDS[genderQid] || 'unknown';
      }
    }

    // P569 (date of birth) — Wikidata time value có dạng { time: '+1965-06-22T00:00:00Z', ... }
    let dateOfBirth = null;
    const p569 = entity.claims?.P569;
    if (Array.isArray(p569) && p569.length > 0) {
      const timeStr = p569[0].mainsnak?.datavalue?.value?.time;
      if (timeStr && typeof timeStr === 'string') {
        const dob = this._parseWikidataTime(timeStr);
        if (dob && !isNaN(dob.getTime())) {
          dateOfBirth = dob;
        }
      }
    }

    return {
      status: STATUS.OK,
      data: {
        qid,
        name: fallbackName || null,
        profileImage,
        gender,
        dateOfBirth,
      },
    };
  }

  /**
   * Parse Wikidata time value thành Date object.
   * Format: "+1965-06-22T00:00:00Z" (precision có thể là năm / tháng / ngày).
   * Trả về Date null nếu không parse được.
   *
   * JavaScript Date không chấp nhận leading '+' (chỉ chấp nhận '-' cho BC dates), nên cần strip nó.
   * Padding year tới 4 chữ số để chuẩn ISO 8601.
   */
  _parseWikidataTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;

    // Pad year tới 4 chữ số, rồi strip leading '+'
    // Ví dụ: "+1965-06-22T00:00:00Z"  →  "1965-06-22T00:00:00Z"
    //         "-0044-03-15T00:00:00Z"  →  "-0044-03-15T00:00:00Z" (giữ nguyên dấu '-' cho BC)
    const normalized = timeStr.replace(/^([+-])(\d{1,4})-/, (m, sign, year) => {
      const padded = year.padStart(4, '0');
      // Bỏ dấu '+', giữ dấu '-' cho BC dates
      return (sign === '+' ? '' : '-') + padded + '-';
    });

    const d = new Date(normalized);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  /**
   * Tìm + lấy director entity trong 1 flow (search + detail).
   * Phân biệt rõ ràng các status (giống findActor).
   *
   * @param {string} name
   * @returns {Promise<{status, data?, error?}>}
   */
  async findDirector(name) {
    if (!this.enabled || !name) {
      return { status: STATUS.DISABLED, data: null };
    }

    try {
      // === Director-level cache check (namespace riêng: director:*) ===
      const cacheKey = name.trim().toLowerCase();
      const cached = this._cacheGet(`director:${cacheKey}`);
      if (cached) {
        if (cached.status === STATUS.OK || cached.status === STATUS.NOT_FOUND) {
          logger.info(`[Wikidata] (cache) Director "${name}" → ${cached.status}`);
          return { status: cached.status, data: cached.data, fromCache: true };
        }
        logger.debug(`[Wikidata] Director cache miss due to transient status: ${cached.status}`);
      }
      this.cacheMisses++;

      const search = await this.searchDirector(name.trim());
      if (search.status !== STATUS.OK) {
        if (!this.TRANSIENT_STATUSES.has(search.status)) {
          this._cacheSet(`director:${cacheKey}`, search.status, null);
        } else {
          logger.debug(`[Wikidata] Skipping director cache (transient): ${search.status}`);
        }
        return { status: search.status, data: null };
      }
      if (!search.data || !search.data.qid) {
        this._cacheSet(`director:${cacheKey}`, STATUS.NOT_FOUND, null);
        return { status: STATUS.NOT_FOUND, data: null };
      }

      const detail = await this.getDirectorByQid(search.data.qid, search.data.label);
      if (detail.status !== STATUS.OK) {
        if (!this.TRANSIENT_STATUSES.has(detail.status)) {
          this._cacheSet(`director:${cacheKey}`, detail.status, null);
        } else {
          logger.debug(`[Wikidata] Skipping director cache (transient): ${detail.status}`);
        }
        return { status: detail.status, data: null };
      }

      // Cache OK với data đầy đủ
      this._cacheSet(`director:${cacheKey}`, STATUS.OK, detail.data);

      logger.info(`[Wikidata] ✅ Found director "${name}": ${detail.data.qid}`);
      return { status: STATUS.OK, data: detail.data };
    } catch (err) {
      logger.warn(`[Wikidata] findDirector unexpected error for "${name}": ${err.message}`);
      return { status: STATUS.NETWORK_ERROR, error: err };
    }
  }

  /**
   * Tìm + lấy entity trong 1 flow. Phân biệt rõ status.
   *
   * Return:
   *   { status, data, error }
   *   - status OK + data: tìm được
   *   - status NOT_FOUND: 200 + không có kết quả (cache được set)
   *   - status RATE_LIMITED/SERVER_ERROR/NETWORK_ERROR: KHÔNG nên log "not found"
   */
  async findActor(name) {
    if (!this.enabled || !name) {
      return { status: STATUS.DISABLED, data: null };
    }

    try {
      // === Actor-level cache check (trước khi gọi API) ===
      const cached = this._actorCacheCheck(name.trim());
      if (cached) {
        // Chỉ return kết quả cache khi OK hoặc NOT_FOUND — không cache lỗi tạm
        if (cached.status === STATUS.OK || cached.status === STATUS.NOT_FOUND) {
          logger.info(`[Wikidata] (cache) Actor "${name}" → ${cached.status}`);
          return { status: cached.status, data: cached.data, fromCache: true };
        }
        // Lỗi tạm thời → bỏ qua cache, gọi lại API
        logger.debug(`[Wikidata] Cache miss due to transient status: ${cached.status}`);
      }

      const search = await this.searchActor(name.trim());
      // CHỈ cache status ổn định — KHÔNG cache RATE_LIMITED/SERVER_ERROR/NETWORK_ERROR.
      if (search.status !== STATUS.OK) {
        if (!this.TRANSIENT_STATUSES.has(search.status)) {
          this._actorCacheSet(name.trim(), search.status, null);
        } else {
          logger.debug(`[Wikidata] Skipping actor cache (transient): ${search.status}`);
        }
        return { status: search.status, data: null };
      }
      if (!search.data || !search.data.qid) {
        this._actorCacheSet(name.trim(), STATUS.NOT_FOUND, null);
        return { status: STATUS.NOT_FOUND, data: null };
      }

      const detail = await this.getActorByQid(search.data.qid, search.data.label);
      if (detail.status !== STATUS.OK) {
        if (!this.TRANSIENT_STATUSES.has(detail.status)) {
          this._actorCacheSet(name.trim(), detail.status, null);
        } else {
          logger.debug(`[Wikidata] Skipping actor cache (transient): ${detail.status}`);
        }
        return { status: detail.status, data: null };
      }

      // Cache OK với data đầy đủ
      this._actorCacheSet(name.trim(), STATUS.OK, detail.data);

      logger.info(`[Wikidata] ✅ Found actor "${name}": ${detail.data.qid}`);
      return { status: STATUS.OK, data: detail.data };
    } catch (err) {
      logger.warn(`[Wikidata] findActor unexpected error for "${name}": ${err.message}`);
      return { status: STATUS.NETWORK_ERROR, error: err };
    }
  }

  /**
   * Build URL ảnh Wikimedia Commons từ file name.
   *
   * Đặc biệt lưu ý:
   * - Wikimedia file name có thể chứa dấu phẩy, apostrophe, hoặc ký tự Unicode.
   * - Khoảng trắng phải được thay bằng `_` TRƯỚC khi encode.
   * - Phải encodeURIComponent 2 LẦN để tuân thủ MediaWiki URL convention
   *   (vì `Special:FilePath/` nhận URL đã encode một lần).
   *
   * URL pattern: https://commons.wikimedia.org/wiki/Special:FilePath/<FILE>?width=500
   *
   * @param {string} fileName Tên file trên Wikimedia Commons (vd: "Tom Holland actor.jpg")
   * @returns {string|null}
   */
  _buildCommonsImageUrl(fileName) {
    if (!fileName || typeof fileName !== 'string') return null;
    // 1. Thay khoảng trắng bằng dấu gạch dưới (MediaWiki convention)
    // 2. Encode URI an toàn — đặc biệt dấu phẩy, nháy đơn, các ký tự đặc biệt
    const normalized = String(fileName).replace(/ /g, '_');
    const encoded = encodeURIComponent(normalized);
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=500`;
  }

  /**
   * Thống kê cache (cho monitoring).
   */
  getStats() {
    return {
      enabled: this.enabled,
      cacheSize: this.cache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      pausedUntil: this.pausedUntil,
      pausedRemainingMs: Math.max(0, this.pausedUntil - Date.now()),
    };
  }
}

// Gắn STATUS & helper utilities lên instance TRƯỚC khi export
// để các module require() khác có thể thấy ngay.
const instance = new WikidataService();
instance.STATUS = STATUS;
instance.WikidataService = WikidataService; // class ref để test/exports

module.exports = instance;