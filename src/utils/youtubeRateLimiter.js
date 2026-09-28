/**
 * YouTube Rate Limiter & Circuit Breaker
 *
 * Implements:
 *   1. Global concurrency limit (default = 1)
 *   2. Global minimum interval between requests (rate limit)
 *   3. Global cooldown after 429 (set by Retry-After header or circuit breaker)
 *   4. Exponential backoff + random jitter
 *   5. Circuit breaker (OPEN / HALF_OPEN / CLOSED)
 *   6. Bounded retries
 *
 * Designed to be SHARED across all YouTube API calls in the process.
 * One singleton = one global budget against the YouTube quota.
 */

const logger = require('./logger');

const STATES = Object.freeze({
  CLOSED: 'CLOSED',       // healthy - requests flow normally
  OPEN: 'OPEN',           // tripped - refuse all requests until cooldown elapsed
  HALF_OPEN: 'HALF_OPEN'  // testing - allow ONE request to probe recovery
});

class YouTubeRateLimiter {
  constructor(opts = {}) {
    this.concurrency = opts.concurrency ?? 1;          // max parallel
    this.maxConcurrent = 0;                            // current active
    this.minIntervalMs = opts.minIntervalMs ?? 5000;   // min ms between request STARTS (global)
    this.lastStartAt = 0;

    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 30000;      // 30s
    this.maxDelayMs = opts.maxDelayMs ?? 3600000;       // 60min cap

    // Circuit breaker
    this.cb = {
      state: STATES.CLOSED,
      failureCount: 0,
      failureThreshold: opts.cbFailureThreshold ?? 3,
      cooldownMs: opts.cbCooldownMs ?? 900000,          // 15min
      openedAt: 0
    };

    // Global cooldown (set when we receive Retry-After)
    this.globalCooldownUntil = 0;
    this.globalCooldownReason = '';

    // Coalesce waiters so they all wake up at the same time
    this._waitQueue = [];
    this._tickHandle = null;
  }

  /** Return ms until the limiter can accept a new request (-ve = ready now). */
  _readyIn() {
    const now = Date.now();

    // Circuit breaker check
    if (this.cb.state === STATES.OPEN) {
      const elapsed = now - this.cb.openedAt;
      if (elapsed >= this.cb.cooldownMs) {
        this.cb.state = STATES.HALF_OPEN;
        logger.info('[YT-Limiter] Circuit breaker → HALF_OPEN (probe)');
      } else {
        return this.cb.cooldownMs - elapsed;
      }
    }

    // Global cooldown (from Retry-After)
    if (now < this.globalCooldownUntil) {
      return this.globalCooldownUntil - now;
    }

    // Concurrency
    if (this.maxConcurrent >= this.concurrency) {
      return 50; // check again soon
    }

    // Global minimum interval
    const sinceLast = now - this.lastStartAt;
    if (sinceLast < this.minIntervalMs) {
      return this.minIntervalMs - sinceLast;
    }

    return 0;
  }

  /**
   * Acquire one slot. Resolves when a slot is granted.
   * Use with try/finally → release() in the caller.
   */
  async acquire() {
    while (true) {
      const wait = this._readyIn();
      if (wait <= 0) {
        this.maxConcurrent += 1;
        this.lastStartAt = Date.now();

        // When HALF_OPEN, this single request is the probe.
        if (this.cb.state === STATES.HALF_OPEN) {
          // leave state as-is; success() will close, failure() will reopen
        }
        return;
      }
      await this._sleep(wait);
    }
  }

  /** Release a slot. Call in finally{} after the request completes. */
  release() {
    if (this.maxConcurrent > 0) this.maxConcurrent -= 1;
    this._drainWaiters();
  }

  /**
   * Report outcome of a YouTube request.
   * status === 429 / 5xx / network error → recordFailure
   * success → recordSuccess
   *
   * @param {Object} info { status?:number, code?:string, retryAfterMs?:number|null }
   * @returns {Object} { shouldRetry:boolean, delayMs:number, reason:string }
   */
  recordOutcome(info = {}) {
    const { status, code, retryAfterMs } = info;
    const isHttpRateLimit = status === 429;
    const isHttpServerError = status != null && status >= 500 && status < 600;
    const isNetworkError = [
      'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
      'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED',
      'ESOCKETTIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'
    ].includes(code);

    if (isHttpRateLimit || isHttpServerError || isNetworkError) {
      return this.recordFailure({ status, retryAfterMs, network: isNetworkError });
    }
    return this.recordSuccess();
  }

  /** Successful response → close circuit if it was HALF_OPEN. */
  recordSuccess() {
    if (this.cb.state !== STATES.CLOSED) {
      logger.info(`[YT-Limiter] ✅ Circuit breaker → CLOSED (recovered after ${this.cb.failureCount} failures)`);
    }
    this.cb.state = STATES.CLOSED;
    this.cb.failureCount = 0;
    // Clear global cooldown on success
    if (this.globalCooldownUntil > 0) {
      this.globalCooldownUntil = 0;
      this.globalCooldownReason = '';
    }
    return { shouldRetry: false, delayMs: 0, reason: 'ok' };
  }

  /**
   * Failure → maybe trip circuit breaker, maybe set global cooldown.
   * Returns retry decision for THIS attempt's caller.
   */
  recordFailure({ status, retryAfterMs = null, network = false } = {}) {
    // If we received Retry-After, honour it as a global cooldown.
    // Cap at maxDelayMs so we don't sit idle for a day.
    if (status === 429 && retryAfterMs && retryAfterMs > 0) {
      const capped = Math.min(retryAfterMs, this.maxDelayMs);
      this.globalCooldownUntil = Date.now() + capped;
      const cappedNote = capped < retryAfterMs
        ? ` (capped from ${Math.round(retryAfterMs / 1000)}s)`
        : '';
      this.globalCooldownReason =
        `Retry-After header (${Math.round(capped / 1000)}s)${cappedNote}`;
      logger.warn(`[YT-Limiter] ⏸  Global cooldown set: ${this.globalCooldownReason}`);
    }

    // Increment circuit breaker failure counter
    this.cb.failureCount += 1;

    if (this.cb.failureCount >= this.cb.failureThreshold && this.cb.state !== STATES.OPEN) {
      this.cb.state = STATES.OPEN;
      this.cb.openedAt = Date.now();
      logger.error(
        `[YT-Limiter] 🔴 Circuit breaker → OPEN ` +
        `(after ${this.cb.failureCount} failures; cooldown=${Math.round(this.cb.cooldownMs / 1000)}s)`
      );
    }

    return {
      shouldRetry: status === 429 || status == null || network,
      delayMs: 0, // computed separately via nextBackoff()
      reason: status === 429 ? 'http_429' : (network ? 'network' : 'http_5xx')
    };
  }

  /**
   * Compute next backoff for a given attempt index (1-based).
   * Combines: exponential backoff + random jitter + max cap.
   * Uses Retry-After if global cooldown is currently set.
   *
   * @param {number} attempt - 1, 2, 3, ...
   * @returns {number} ms to sleep before next attempt (0 = don't retry)
   */
  nextBackoff(attempt) {
    if (attempt > this.maxRetries) return 0;

    // If Retry-After set a global cooldown, respect it.
    if (Date.now() < this.globalCooldownUntil) {
      return this.globalCooldownUntil - Date.now();
    }

    // Exponential backoff: base * 2^(attempt-1)
    const exp = Math.min(this.baseDelayMs * Math.pow(2, attempt - 1), this.maxDelayMs);
    // Random jitter: 0..30% of exp
    const jitter = Math.floor(Math.random() * exp * 0.3);
    return exp + jitter;
  }

  /** True if request budget is currently exhausted (circuit OPEN). */
  isCircuitOpen() {
    return this.cb.state === STATES.OPEN;
  }

  /** For diagnostics / status endpoint. */
  status() {
    return {
      concurrency: this.concurrency,
      active: this.maxConcurrent,
      cbState: this.cb.state,
      cbFailureCount: this.cb.failureCount,
      globalCooldownUntil: this.globalCooldownUntil > 0
        ? new Date(this.globalCooldownUntil).toISOString()
        : null,
      globalCooldownReason: this.globalCooldownReason || null,
      lastStartAt: this.lastStartAt > 0 ? new Date(this.lastStartAt).toISOString() : null
    };
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  _drainWaiters() {
    // Currently we use polling in acquire(); this is a no-op hook.
  }
}

module.exports = new YouTubeRateLimiter({
  concurrency: parseInt(process.env.YOUTUBE_CONCURRENCY || '1', 10),
  maxRetries: parseInt(process.env.YOUTUBE_MAX_RETRIES || '3', 10),
  baseDelayMs: parseInt(process.env.YOUTUBE_RETRY_BASE_DELAY_MS || '30000', 10),
  maxDelayMs: parseInt(process.env.YOUTUBE_RETRY_MAX_DELAY_MS || '3600000', 10),
  cbFailureThreshold: parseInt(process.env.YOUTUBE_CIRCUIT_FAILURE_THRESHOLD || '3', 10),
  cbCooldownMs: parseInt(process.env.YOUTUBE_CIRCUIT_COOLDOWN_MS || '900000', 10),
  minIntervalMs: parseInt(process.env.YOUTUBE_REQUEST_DELAY || '5000', 10)
});
module.exports.STATES = STATES;