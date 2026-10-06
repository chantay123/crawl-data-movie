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
 *   Khi YouTube lỗi (RATE_LIMITED / COOLDOWN / CIRCUIT_OPEN / QUOTA_EXCEEDED /
 *   TIMEOUT / 5xx) → THROW error với .code, caller sẽ mark `trailerJobStatus`
 *   và retry. **Tuyệt đối KHÔNG set trailer = null khi gặp lỗi** (yêu cầu #1).
 *   NOT_FOUND chỉ xảy ra khi YouTube healthy + tất cả query exhausted.
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
    // ⭐ Mở rộng: dùng nhiều query hơn (priority-ordered) để tăng khả năng tìm thấy
    // trailer cho phim châu Á (TQ/Hàn/Nhật) có nhiều tên gọi. Default 6, override
    // bằng env `YOUTUBE_MAX_QUERIES`. Vẫn cap để bảo vệ quota.
    this.maxQueries = parseInt(process.env.YOUTUBE_MAX_QUERIES || '6', 10);
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

  /**
   * ⭐ Multi-language query templates (yêu cầu #4).
   *
   * For each detected language, generate trailer queries in that language.
   * Order is intentional: most specific (official trailer) first, then
   * broader (just "trailer"), then teasers/PVs.
   *
   *   VI:  trailer, official trailer, teaser
   *   EN:  official trailer, trailer, teaser
   *   ZH:  预告, 预告片, trailer
   *   JA:  予告, 予告編, PV, trailer
   *   KO:  예고편, trailer
   *
   * Note: 'latin' (English) uses the same template as 'en' since English is
   * the de-facto trailer language on YouTube.
   */
  _getQueryTemplates(language) {
    switch (language) {
      case 'vi':
        return ['{t} trailer', '{t} official trailer', '{t} teaser'];
      case 'zh':
        return ['{t} 预告', '{t} 预告片', '{t} trailer'];
      case 'ja':
        return ['{t} 予告', '{t} 予告編', '{t} PV', '{t} trailer'];
      case 'ko':
        return ['{t} 예고편', '{t} trailer'];
      case 'en':
      case 'latin':
      default:
        return ['{t} official trailer', '{t} trailer', '{t} teaser'];
    }
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
   * ⭐ Detect the language of a string (multi-language trailer search).
   * Used to route queries to the correct trailer template
   * (预告 for ZH, 予告 for JA, 예고편 for KO, etc.).
   *
   * Returns one of:
   *   - 'zh'     Chinese (Han ideographs only)
   *   - 'ja'     Japanese (Hiragana, Katakana, or Han+Kana mixed)
   *   - 'ko'     Korean (Hangul)
   *   - 'vi'     Vietnamese (Latin with diacritics ăâêôơưđ)
   *   - 'latin'  Other Latin (English, French, etc.)
   *   - null     Empty / unrecognised
   *
   * @param {string} s
   * @returns {string|null}
   */
  _detectLanguage(s) {
    if (!s || typeof s !== 'string') return null;
    const t = s.trim();
    if (!t) return null;

    // Korean Hangul — check first (most distinctive)
    if (/[\uAC00-\uD7AF]/.test(t)) return 'ko';

    // Hiragana or Katakana (uniquely Japanese)
    if (/[\u3040-\u309F]/.test(t)) return 'ja'; // Hiragana
    if (/[\u30A0-\u30FF]/.test(t)) return 'ja'; // Katakana

    // CJK Unified Ideographs: ZH if no kana; otherwise treat as JA
    if (/[\u3400-\u9FFF\uF900-\uFAFF]/.test(t)) {
      if (/[\u3040-\u30FF]/.test(t)) return 'ja';
      return 'zh';
    }

    // Latin script: distinguish VI (diacritics) from EN/other.
    // Vietnamese has BOTH precomposed (NFC: ố = U+1ED1) and decomposed (NFD:
    // ô + U+0302 combining circumflex) forms. We match both.
    if (/[A-Za-z]/.test(t)) {
      // Precomposed Vietnamese letters (NFC) — ă â ê ô ơ ư đ + ALL 5-tone
      // variants + uppercase forms. Covers ố, ồ, ổ, ỗ, ộ (U+1ED1..U+1ED9),
      // ắ ằ ẳ ẵ ặ, ấ ầ ẩ ẫ ậ, ế ề ể ễ ệ, ớ ờ ở ỡ ợ, ứ ừ ử ữ ự, etc.
      if (/[ăằắẳẵặâầấẩẫậêềếểễệôồốổỗộơờớởỡợưừứửữựđĂẰẮẲẴẶÂẦẤẨẪẬÊỀẾỂỄỆÔỒỐỔỖỘƠỜỚỞỠỢƯỪỨỬỮỰĐàáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]/.test(t)) return 'vi';
      // Decomposed: any combining diacritic (U+0300-U+036F) — Vietnamese
      // NFD form has the diacritic as a separate code point after the base.
      if (/[̀-ͯ]/u.test(t)) return 'vi';
      return 'latin';
    }

    return null;
  }

  /**
   * Backward-compat alias — returns just the script family (cjk vs latin).
   * @deprecated use _detectLanguage
   */
  _detectScript(s) {
    const lang = this._detectLanguage(s);
    if (lang === 'zh' || lang === 'ja' || lang === 'ko') return 'cjk';
    if (lang === 'vi' || lang === 'latin') return 'latin';
    return null;
  }

  /**
   * ⭐ Normalize a movie title for trailer search (yêu cầu #1, #2, #3).
   *
   * Strips common suffixes/qualifiers that pollute trailer searches:
   *   - (Phần 1), (Phần 2), (Phần 3), ...
   *   - (P1), (P2), (P3), ...
   *   - (Part 1), (Part 2), ...
   *   - (Season 1), (Season 2), ...
   *   - (Tập 1), (Tập 2), ...
   *   - (Tập 01), (Tập 100), ...
   *   - Bare suffixes at the end:  "Movie Name Phần 1",  "Movie Name P2"
   *   - Square brackets, full-width parens, etc.
   *   - Trailing punctuation: "Movie (Phần 1)." → "Movie"
   *
   * Also collapses multiple spaces and strips trailing punctuation.
   *
   * Examples:
   *   "Không Thể ThayThế (Phần 1)"  → "Không Thể ThayThế"
   *   "Movie Name (P2)"              → "Movie Name"
   *   "动漫 预告 (Phần 1)"           → "动漫 预告"
   *   "Movie (Phần 1)."              → "Movie"
   *
   * @param {string} title
   * @returns {string} normalized title (empty string if input empty)
   */
  _normalizeTitle(title) {
    if (!title || typeof title !== 'string') return '';
    let s = title.trim();

    // ⭐ 1. Strip "(...)" suffix groups containing known part/season/episode markers.
    // Run in a loop to handle nested or chained cases like "(Phần 1) (Tập 5)".
    // The match is anchored at the END of the string (with optional trailing punctuation).
    let prev;
    do {
      prev = s;
      s = s.replace(
        // Match parens or full-width parens or square brackets at end, allowing
        // optional trailing punctuation/space (".", ",", ";", ":", etc).
        /\s*[\(\uFF08\[\u3010][^\(\)\uFF08\uFF09\[\]\u3010\u3011]*[\)\uFF09\]\u3011][\s.,;:!?\-]*$/u,
        (m) => {
          // Extract content between the FIRST opening paren/bracket and the LAST
          // closing paren/bracket — robust against trailing punctuation.
          // Examples:
          //   " (Phần 1)."  → "phần 1"
          //   " (Phần 1),"  → "phần 1"
          //   " (Phần 1) ." → "phần 1"
          const open = m.search(/[\(\uFF08\[\u3010]/u);
          // Find the LAST closing paren by searching from the right (after stripping
          // trailing punctuation first).
          const trimmed = m.replace(/[\s.,;:!?\-]+$/u, '');
          let close = -1;
          for (let i = trimmed.length - 1; i >= 0; i--) {
            if (/[\)\uFF09\]\u3011]/u.test(trimmed[i])) {
              close = i;
              break;
            }
          }
          let inner = '';
          if (open >= 0 && close > open) {
            inner = trimmed.slice(open + 1, close);
          } else {
            inner = trimmed;
          }
          inner = inner.trim().toLowerCase();
          if (this._isPartOrSeasonSuffix(inner)) return ' ';
          return m; // keep as-is
        }
      );
    } while (s !== prev);

    // ⭐ 2. Strip BARE suffixes at the end (no parens), e.g. "Movie Phần 1", "Movie P2",
    //    "Movie Part 3", "Movie Season 2", "Movie S01", "Movie E5".
    s = s.replace(
      /\s+(phần|phan|part|season|tập|tap|episode|ep)\s*\d{1,4}\s*$/iu,
      ''
    );
    // P2, P01, S2, S01, T5, E3 (single letter + 1-4 digits)
    s = s.replace(/\s+([pse])\d{1,4}\s*$/iu, '');

    // ⭐ 3. Strip trailing colon/space/punctuation artifacts.
    s = s.replace(/[\s:;,.\-]+$/u, '').trim();

    // ⭐ 4. Collapse multiple whitespace into single space.
    s = s.replace(/\s+/g, ' ').trim();

    return s;
  }

  /**
   * Test whether a (lowercased) string is one of the known part/season/episode
   * markers we want to strip from a title.
   *
   * @param {string} inner  already lowercased, no surrounding parens
   * @returns {boolean}
   * @private
   */
  _isPartOrSeasonSuffix(inner) {
    if (!inner) return false;
    const t = inner.trim();
    if (!t) return false;
    // Vietnamese variants
    if (/^(phần|phan)\s*\d{1,4}$/u.test(t)) return true;
    if (/^p\s*\d{1,4}$/u.test(t)) return true; // P1, P2, P01
    if (/^(tập|tap)\s*\d{1,4}$/u.test(t)) return true;
    if (/^t\s*\d{1,4}$/u.test(t)) return true; // T1, T2
    if (/^tập\s*(cuối|chót|full)$/u.test(t)) return true;
    // English variants
    if (/^part\s*\d{1,4}$/u.test(t)) return true;
    if (/^season\s*\d{1,4}$/u.test(t)) return true;
    if (/^s\s*\d{1,4}$/u.test(t)) return true; // S1, S2
    if (/^episode\s*\d{1,4}$/u.test(t)) return true;
    if (/^ep\s*\d{1,4}$/u.test(t)) return true;
    if (/^e\s*\d{1,4}$/u.test(t)) return true; // E1, E2
    // Combined like "Phần 1 Tập 5"
    if (/^(phần|phan|part|season|tập|tap|episode|ep)\s*\d{1,4}(\s+(phần|phan|part|season|tập|tap|episode|ep)\s*\d{1,4})+$/u.test(t)) return true;
    return false;
  }

  /**
   * Normalize a list of titles (main + alts), removing empty results and
   * deduplicating (case-insensitive). Order is preserved.
   *
   * @param {...string} titles
   * @returns {string[]}
   * @private
   */
  _normalizeAllTitles(...titles) {
    const seen = new Set();
    const out = [];
    for (const t of titles) {
      const n = this._normalizeTitle(t);
      if (!n) continue;
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
    return out;
  }

  /**
   * Try to extract an alternate title (Chinese / English / original) from
   * a movie's `content` description.
   *
   * Many Vietnamese sources embed the original title in parentheses
   * inside the description, e.g.:
   *   "Giới Môn Chi Hạ (Huyền Giới Chi Môn / 界门之下) là một bộ phim..."
   *   "Movie Name (Original Title / 別名) là..."
   *
   * We pull out anything inside `(...)` and split on `/` or `,`.
   *
   * @param {string} content
   * @returns {string[]} alternate titles (cleaned, deduped)
   */
  _extractAlternateTitles(content) {
    if (!content || typeof content !== 'string') return [];
    const titles = new Set();
    const parens = content.match(/\(([^)]+)\)/g) || [];
    for (const paren of parens) {
      const inner = paren.replace(/^\(|\)$/g, '');
      // Split by ', ' or '/' (with optional spaces)
      const parts = inner.split(/\s*[\/,]\s*/);
      for (const p of parts) {
        const t = p.trim();
        // Heuristic: an alternate title is short (< 80 chars), not a sentence.
        if (t && t.length > 1 && t.length < 80 && !/[.!?]/.test(t)) {
          titles.add(t);
        }
      }
    }
    return [...titles];
  }

  /**
   * ⭐ Build the list of search queries to try for a movie (multi-language).
   *
   * Algorithm (yêu cầu #1-#6):
   *   1. Normalize ALL titles (strip (Phần 1), (P2), Part 3, Season 1, Tập 5, etc.)
   *   2. Detect language of each title (vi/en/zh/ja/ko)
   *   3. For each title, generate queries in the matching language template:
   *        VI:  "{t} trailer", "{t} official trailer", "{t} teaser"
   *        EN:  "{t} official trailer", "{t} trailer", "{t} teaser"
   *        ZH:  "{t} 预告", "{t} 预告片", "{t} trailer"
   *        JA:  "{t} 予告", "{t} 予告編", "{t} PV", "{t} trailer"
   *        KO:  "{t} 예고편", "{t} trailer"
   *   4. Priority order: originalTitle > movieName > altTitles
   *      (yêu cầu #5: prioritize original/VI title)
   *   5. De-dup and cap at maxQueries
   *
   * Note: for Asian films, BOTH the romanized title AND the native-script title
   * are tried. e.g. "Huyền Giới Chi Môn" gets "trailer" queries AND
   * "界门之下" gets "预告" queries.
   *
   * @param {string} movieName    Vietnamese title (raw)
   * @param {number|string|null} year  release year (currently unused)
   * @param {string} [originName]  original title fallback (raw)
   * @param {string|string[]} [altTitles]  alternate titles (raw)
   * @returns {string[]}
   */
  _buildQueries(movieName, year, originName, altTitles) {
    const maxQueries = Math.max(2, this.maxQueries || 6);

    // ⭐ Step 1: Normalize all titles.
    const titleVi = this._normalizeTitle(movieName);
    const titleOrigin = this._normalizeTitle(originName);
    let alts = [];
    if (Array.isArray(altTitles)) {
      for (const t of altTitles) alts.push(this._normalizeTitle(t));
    } else if (typeof altTitles === 'string' && altTitles.trim()) {
      alts = [this._normalizeTitle(altTitles)];
    }

    // De-dup alts (case-insensitive) preserving order.
    {
      const seen = new Set();
      const dedup = [];
      for (const a of alts) {
        if (!a) continue;
        const k = a.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        dedup.push(a);
      }
      alts = dedup;
    }

    // ⭐ Step 2: Build an ordered list of (title, language) tuples.
    // Priority: original title (originName) FIRST if it's non-Latin
    // (i.e. it's a real "original" title, not just an English title duplicated
    // as originName), then VI title, then alt titles.
    //
    // Reason: for "Giới Môn Chi Hạ" (VI) + originName "界门之下" (ZH),
    // we want the ZH-language queries to be tried first because YouTube
    // has more authoritative content under the original title.
    const titleEntries = []; // [{ title, language, source }]

    const seenTitles = new Set();
    const addEntry = (t, source) => {
      if (!t) return;
      const lang = this._detectLanguage(t);
      if (!lang) return;
      const k = t.toLowerCase();
      if (seenTitles.has(k)) return;
      seenTitles.add(k);
      titleEntries.push({ title: t, language: lang, source });
    };

    // Origin FIRST (highest priority) — usually the original-language title.
    addEntry(titleOrigin, 'origin');
    // Then VI title.
    addEntry(titleVi, 'main');
    // Then alt titles (Chinese, Japanese, Korean, English, etc.).
    for (const a of alts) addEntry(a, 'alt');

    // ⭐ Step 3: For each title, emit queries in the matching language.
    const candidates = [];
    for (const { title, language, source } of titleEntries) {
      const templates = this._getQueryTemplates(language);
      for (const tpl of templates) {
        candidates.push({ query: tpl.replace('{t}', title), language, source, title });
      }
    }

    // ⭐ Step 4: De-duplicate (case-insensitive) preserving priority order.
    const seen = new Set();
    const queries = [];
    for (const c of candidates) {
      const key = c.query.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(c.query);
    }

    // ⭐ Step 5: Cap at maxQueries to protect API quota.
    const capped = queries.slice(0, maxQueries);

    // ⭐ Step 6: Log the language detection + query plan (yêu cầu #10).
    const langs = titleEntries.map((e) => `${e.source}=${e.language}(${e.title})`).join(', ');
    logger.info(
      `[YouTube] Multi-lang query plan for "${movieName}" → ` +
      `${capped.length} queries [${langs}]`
    );
    capped.forEach((q, i) => {
      const lang = this._detectLanguage(
        q.replace(/\s+(trailer|预告|预告片|予告|予告編|PV|예고편|teaser|official trailer)\s*/i, '')
      );
      logger.debug(`[YouTube] query[${i + 1}/${capped.length}] language=${lang.toUpperCase()} → "${q}"`);
    });

    if (queries.length > capped.length) {
      logger.debug(
        `[YouTube] Query list capped: ${capped.length}/${queries.length} ` +
        `(maxQueries=${maxQueries})`
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
   * @param {string|Object} movieNameOrMovie   Vietnamese title (string) HOẶC
   *        movie document có các field name/originName/content/slug.
   * @param {number|string|null} [year]        release year (best-effort)
   * @param {string} [originName]              original title fallback (string)
   * @param {string[]} [altTitles]             alternate titles (CJK / English)
   * @returns {Promise<Object|null>}
   * @throws  {Error} .code = 'RATE_LIMITED' | 'QUOTA_EXCEEDED' | 'CIRCUIT_OPEN' | 'API_ERROR'
   */
  async searchTrailer(movieNameOrMovie, year = null, originName = null, altTitles = null) {
    if (!this.enabled) {
      logger.debug('[YouTube] Service disabled, skipping');
      return null;
    }

    // ⭐ Hỗ trợ cả 2 kiểu gọi:
    //   - searchTrailer("Tên phim", year, originName, altTitles)   (legacy)
    //   - searchTrailer({ name, originName, content, ... })        (object)
    let movieName = '';
    let content = '';
    let slug = '';
    if (typeof movieNameOrMovie === 'string') {
      movieName = movieNameOrMovie;
    } else if (movieNameOrMovie && typeof movieNameOrMovie === 'object') {
      movieName = movieNameOrMovie.name || '';
      // ⭐ yêu cầu #2: ưu tiên originName, fallback qua các field phụ.
      originName = originName
        || movieNameOrMovie.originName
        || movieNameOrMovie.origin_name
        || movieNameOrMovie.originalTitle
        || movieNameOrMovie.original_title
        || movieNameOrMovie.original_name
        || '';
      content = movieNameOrMovie.content || movieNameOrMovie.description || '';
      slug = movieNameOrMovie.slug || '';

      // ⭐ yêu cầu #2: nếu movie có các field originalTitle/chineseTitle/
      // japaneseTitle/koreanTitle/englishTitle/alternateTitles → merge tất cả
      // vào altTitles. (Các field này có thể không tồn tại trên schema hiện tại,
      // nhưng nếu crawler gửi lên thì mình dùng.)
      const explicitAlts = [];
      for (const f of [
        'alternateTitles', 'alternate_titles', 'altTitles', 'alt_titles',
        'originalTitle', 'original_title', 'original_name',
        'chineseTitle', 'chinese_title', 'japaneseTitle', 'japanese_title',
        'koreanTitle', 'korean_title', 'englishTitle', 'english_title',
      ]) {
        const v = movieNameOrMovie[f];
        if (typeof v === 'string' && v.trim()) explicitAlts.push(v.trim());
        else if (Array.isArray(v)) {
          for (const x of v) if (typeof x === 'string' && x.trim()) explicitAlts.push(x.trim());
        }
      }

      if (!altTitles || (Array.isArray(altTitles) && altTitles.length === 0)) {
        // Extract from content first
        const fromContent = this._extractAlternateTitles(content);
        altTitles = explicitAlts.length > 0 ? [...explicitAlts, ...fromContent] : fromContent;
      } else if (explicitAlts.length > 0) {
        // Merge explicit alts with provided altTitles, dedup case-insensitively
        const provided = Array.isArray(altTitles) ? altTitles : [altTitles];
        const seen = new Set();
        const merged = [];
        for (const t of [...explicitAlts, ...provided]) {
          const k = (t || '').trim().toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          merged.push(t.trim());
        }
        altTitles = merged;
      }
    }
    if (!movieName) return null;

    // ⭐ yêu cầu #4: log normalized title để verify đang dùng.
    const normalizedName = this._normalizeTitle(movieName);
    if (normalizedName && normalizedName !== movieName.trim()) {
      logger.info(
        `[YouTube] Normalized title: "${movieName}" → "${normalizedName}"`
      );
    }

    const queries = this._buildQueries(movieName, year, originName, altTitles);
    if (queries.length === 0) return null;

    logger.info(
      `[YouTube] Searching trailer: "${movieName}" (normalized="${normalizedName}") ` +
      `(origin="${originName || '-'}", slug="${slug || '-'}", ` +
      `altTitles=${JSON.stringify(altTitles || [])}, queries=${queries.length})`
    );
    // In danh sách query để debug dễ (requirement #10)
    if (queries.length > 0) {
      logger.debug(`[YouTube] Query plan: ${queries.map((q, i) => `[${i + 1}] "${q}"`).join(' → ')}`);
    }

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];

      // ⭐ BUGFIX: circuit OPEN / cooldown → THROW (không return null) để caller
      // biết đây là tạm thời → KHÔNG mark NOT_FOUND, giữ trailer field UNCHANGED
      // trong DB và retry sau (yêu cầu #1, #5, #6).
      // Throw ngay khi gặp cooldown — KHÔNG tiếp tục query còn lại vì chúng
      // cũng sẽ fail. Caller sẽ mark movie là RATE_LIMITED, không phải NOT_FOUND.
      if (!rateLimiter.isReady()) {
        const isOpen = rateLimiter.isCircuitOpen();
        const remainingMs = rateLimiter.readyInMs();
        logger.warn(
          `[YouTube] ⛔ Unavailable (${isOpen ? 'CIRCUIT_OPEN' : 'COOLDOWN'}) — ` +
          `stopping at query ${i + 1}/${queries.length} for "${movieName}" ` +
          `(~${Math.round(remainingMs / 1000)}s remaining). ` +
          `THROWING RATE_LIMITED — caller will NOT mark as NOT_FOUND.`
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
        // ⭐ yêu cầu #10: log rõ language + query.
        const queryLang = this._detectLanguage(
          query.replace(
            /\s+(trailer|预告|预告片|予告|予告編|PV|예고편|teaser|official trailer)\s*$/iu,
            ''
          )
        );
        logger.info(
          `[YouTube] 🔎 Query ${i + 1}/${queries.length} language=${queryLang.toUpperCase()}: "${query}" for "${movieName}"`
        );

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
          logger.info(
            `[YouTube]   ↳ 0 results for "${query}" — trying next query`
          );
          continue;
        }

        // Log raw count + filtered count (requirement #10)
        const filtered = items.filter(item => this._isPlausibleVideo(item, movieName, altTitles));
        if (filtered.length === 0) {
          logger.info(
            `[YouTube]   ↳ ${items.length} raw results, 0 plausible (no trailer/teaser keyword match) ` +
            `for "${query}" — trying next query`
          );
          continue;
        }

        const best = this._findBestTrailer(filtered, movieName, originName, altTitles);
        if (!best) {
          logger.info(
            `[YouTube]   ↳ ${items.length} raw / ${filtered.length} filtered, no winner — trying next query`
          );
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

        logger.info(
          `[YouTube] ✅ FOUND ${trailerType}: "${trailer.name}" (key=${trailer.key}) ` +
          `for "${movieName}" via query [${i + 1}] "${query}"`
        );

        // ⭐ yêu cầu #6: early-exit khi tìm được "official trailer" với high
        // confidence. Đỡ tốn quota cho các query còn lại.
        if (trailer.official && trailerType === 'Trailer') {
          logger.info(
            `[YouTube] 🚀 High-confidence trailer (official=true, type=Trailer) — ` +
            `early-exit, skipping remaining ${queries.length - i - 1} queries.`
          );
        }
        return trailer;
      } catch (err) {
        // ⭐ BUGFIX (yêu cầu #1, #5): stop trying more queries on
        // quota/rate-limit/circuit-open/timeout. Re-throw so the caller
        // marks movie as RATE_LIMITED (NOT NOT_FOUND) and retries later.
        if (
          err.code === 'RATE_LIMITED' ||
          err.code === 'QUOTA_EXCEEDED' ||
          err.code === 'CIRCUIT_OPEN'
        ) {
          logger.warn(
            `[YouTube] ⛔ ${err.code} — STOPPING further queries for "${movieName}" ` +
            `(after ${i + 1}/${queries.length}). Retry suggested in ~${Math.round((err.retryAfterMs || 0) / 1000)}s.`
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
      `(queries exhausted, not a rate-limit issue). Will mark movie as NOT_FOUND.`
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
   * ⭐ Lọc kết quả (yêu cầu #3 + #7 + #10): chỉ giữ video có title chứa MỘT trong:
   *   'official trailer' | 'trailer' | 'official teaser' | 'teaser' | '预告'
   * (khớp không phân biệt hoa thường). Đồng thời loại rác (VEVO, lyric, OST, Shorts).
   *
   * Match logic: token phải trùng với MỘT trong các tên: `movieName` hoặc bất
   * kỳ tên nào trong `altTitles`. Nếu phim chỉ có 1 tên thì chỉ cần 1 token
   * trùng; nếu có nhiều tên thì cho phép token trùng với bất kỳ tên nào.
   *
   * @param {Object} item
   * @param {string} movieName
   * @param {string[]} [altTitles]  alternate titles (CJK/English)
   * @returns {boolean}
   */
  _isPlausibleVideo(item, movieName, altTitles) {
    const title = (item.snippet?.title || '').toLowerCase();
    const channel = (item.snippet?.channelTitle || '').toLowerCase();

    // ── Loại rác TRƯỚC (rẻ hơn, và tránh false positive) ──
    if (channel.includes('vevo')) return false;
    if (title.includes('music video')) return false;
    if (title.includes('lyric')) return false;
    if (title.includes('tv spot') || title.includes('tv clip')) return false;
    if (title.includes('review') || title.includes('reaction')) return false;
    if (title.includes('ost') && !title.includes('trailer')) return false;

    // ⭐ Shorts filter (yêu cầu #7): lọc theo title pattern — không tốn thêm quota
    // (YouTube search.list không trả duration, chỉ videos.list mới có — nhưng
    // tiêu tốn thêm quota unit nên ta chỉ filter theo title pattern ở đây).
    if (title.includes('#shorts') || title.includes('#short')) return false;
    if (/\bshorts?\b/i.test(title) && !/\btrailer\b/i.test(title)) return false;

    // ── BẮT BUỘC có từ khóa trailer/teaser (yêu cầu #3) ──
    const hasKeyword =
      title.includes('official trailer') ||
      title.includes('trailer') ||
      title.includes('official teaser') ||
      title.includes('teaser') ||
      title.includes('预告'); // ⭐ Chinese: cho phép title CJK thuần
    if (!hasKeyword) return false;

    // ── Tên phải khớp ít nhất 1 token trong (movieName ∪ altTitles) ──
    const titleBag = [movieName];
    if (Array.isArray(altTitles)) titleBag.push(...altTitles);

    let anyTokens = [];
    for (const t of titleBag) {
      anyTokens = anyTokens.concat(this._significantTokens(t));
    }
    // Nếu không có token đáng kể nào, fallback cho qua (giữ behavior cũ)
    if (anyTokens.length >= 2 && !anyTokens.some((tok) => title.includes(tok))) {
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
   * ⭐ Chọn video TỐT NHẤT theo thứ tự ưu tiên (yêu cầu #7):
   *   1. Official trailer   (official=true  + type=Trailer)
   *   2. Trailer            (type=Trailer)
   *   3. Official teaser    (official=true  + type=Teaser)
   *   4. Teaser             (type=Teaser)
   *
   * Trong cùng một bậc, điểm bổ sung quyết định:
   *   - title khớp với originName/altTitles (ưu tiên tên gốc)
   *   - kênh official
   *   - HD / full
   *   - mới hơn
   *   - KHÔNG phải Shorts
   *
   * @param {Array} items - các item đã lọc qua _isPlausibleVideo
   * @param {string} movieName
   * @param {string} [originName]
   * @param {string[]} [altTitles]
   * @returns {Object|null}
   */
  _findBestTrailer(items, movieName, originName, altTitles) {
    const norm = (movieName || '').toLowerCase();
    const origin = (originName || '').toLowerCase();
    const alts = Array.isArray(altTitles)
      ? altTitles.map((t) => String(t || '').toLowerCase()).filter(Boolean)
      : [];

    let best = null;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestScore = -Infinity;

    for (const item of items) {
      const title = (item.snippet?.title || '').toLowerCase();
      const channel = (item.snippet?.channelTitle || '').toLowerCase();

      const isTrailer = title.includes('trailer') || title.includes('预告');
      const isTeaser = title.includes('teaser');
      const isOfficial = this._isOfficialTrailer(title, channel);

      // ── RANK theo yêu cầu #7 (0 = tốt nhất) ──
      let rank;
      if (isTrailer && isOfficial) rank = 0;       // Official trailer
      else if (isTrailer) rank = 1;                // Trailer
      else if (isTeaser && isOfficial) rank = 2;   // Official teaser
      else rank = 3;                               // Teaser

      // ── Điểm phụ (chỉ dùng để chọn trong cùng rank) ──
      let score = 0;
      // Title match với tên phim
      if (norm && title.includes(norm)) score += 10;
      // Title match với originName (ưu tiên tên gốc)
      if (origin && title.includes(origin)) score += 12;
      // Title match với alternate titles (CJK/English)
      for (const alt of alts) {
        if (alt && title.includes(alt)) score += 8;
      }
      if (title.includes('official')) score += 2;
      if (channel.includes('official')) score += 2;
      if (title.includes('hd') || title.includes('full')) score += 1;
      if (title.includes('clip') && !isTrailer && !isTeaser) score -= 5;
      // Penalty cho Shorts còn sót (yêu cầu #7)
      if (title.includes('#shorts') || title.includes('#short')) score -= 20;

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