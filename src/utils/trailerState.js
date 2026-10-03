/**
 * trailerState - Shared, in-process state cho trailer pipeline (YouTube-only).
 *
 * Mục tiêu:
 *   1. IN-FLIGHT LOCK per movie  → cùng 1 movie KHÔNG bị xử lý đồng thời
 *   2. RETRY-AT COOLDOWN         → tôn trọng `trailerRetryAt` (now < retryAt → SKIP)
 *   3. DEDUPLICATION window      → cùng 1 movie không bị xử lý lại trong cửa sổ ngắn
 *   4. RECENTLY-PROCESSED cache  → batch nhiều lần không xử lý lại movie vừa xử lý
 *
 * ⭐ Circuit breaker cho YouTube KHÔNG nằm ở đây mà ở `utils/youtubeRateLimiter.js`
 *   (single source of truth cho cooldown / quota / circuit state).
 *
 * KHÔNG đụng vào schema / không tạo collection. Toàn bộ state nằm trong RAM.
 *
 * Lưu ý về phạm vi: state là in-process. Nếu chạy nhiều worker Node.js khác nhau
 * (pm2 cluster / nhiều container) thì cần shared store (Redis). Với kiến trúc
 * hiện tại (single crawler process + server API) thì in-process là đủ và KHÔNG
 * thêm dependency mới.
 */

// ============================================================================
// (đã bỏ) TMDB circuit breaker config — trailer chỉ dùng YouTube
// ============================================================================

class TrailerState {
  constructor() {
    // movieId -> timestamp khi bắt đầu xử lý (in-flight)
    this.inFlight = new Map();

    // movieId -> { status, retryAt, source, at } — mirror trạng thái DB để
    // quyết định skip trước khi đụng network.
    this.movieCooldown = new Map();

    // movieId -> timestamp lần xử lý gần nhất (dedupe window)
    this.lastProcessedAt = new Map();

    // Dedupe window: sau khi xử lý 1 movie, không xử lý lại trong N ms
    this.dedupeWindowMs = parseInt(process.env.TRAILER_DEDUPE_WINDOW_MS || '60000', 10);
  }

  // ==========================================================================
  // 1. IN-FLIGHT LOCK (per movie)
  // ==========================================================================

  /**
   * Thử acquire lock cho movie. Trả false nếu movie đang được xử lý.
   * @param {string} movieId
   * @returns {boolean} true nếu acquire thành công
   */
  acquire(movieId) {
    if (!movieId) return true;
    const now = Date.now();
    const existing = this.inFlight.get(movieId);

    if (existing !== undefined) {
      // Lock đang giữ → kiểm tra có stale không (nếu process bị treo)
      if (now - existing < this.lockTimeoutMs) {
        return false;
      }
      // Lock quá cũ (stale) → coi như đã release
      this.inFlight.delete(movieId);
    }

    this.inFlight.set(movieId, now);
    return true;
  }

  /** Release lock cho movie. */
  release(movieId) {
    if (movieId) this.inFlight.delete(movieId);
  }

  /** True nếu movie đang được xử lý. */
  isLocked(movieId) {
    return movieId ? this.inFlight.has(movieId) : false;
  }

  /** Số movie đang xử lý (diagnostics). */
  inFlightCount() {
    return this.inFlight.size;
  }

  // ==========================================================================
  // 2. RETRY-AT COOLDOWN
  // ==========================================================================

  /**
   * Ghi nhận movie bị RATE_LIMITED với retryAt.
   * @param {string} movieId
   * @param {Date|null} retryAt
   * @param {string} [reason]
   */
  setCooldown(movieId, retryAt, reason = 'RATE_LIMITED') {
    if (!movieId) return;
    const at = retryAt instanceof Date ? retryAt.getTime() : Date.now();
    this.movieCooldown.set(movieId, {
      status: reason,
      retryAt,
      retryAtMs: at,
      at: Date.now(),
    });
  }

  /**
   * Lấy thông tin cooldown của movie.
   * @param {string} movieId
   * @returns {{status:string, retryAt:Date|null, retryAtMs:number, at:number}|null}
   */
  getCooldown(movieId) {
    if (!movieId) return null;
    return this.movieCooldown.get(movieId) || null;
  }

  /**
   * Kiểm tra movie có đang trong cooldown không (now < retryAt).
   * @param {string} movieId
   * @returns {{skip:boolean, reason:string|null, retryAt:Date|null, remainingMs:number}}
   */
  shouldSkipForCooldown(movieId) {
    const cd = this.getCooldown(movieId);
    if (!cd) return { skip: false, reason: null, retryAt: null, remainingMs: 0 };

    const now = Date.now();
    if (now < cd.retryAtMs) {
      return {
        skip: true,
        reason: cd.status,
        retryAt: cd.retryAt,
        remainingMs: cd.retryAtMs - now,
      };
    }
    // Đã hết cooldown → clear và cho qua
    this.movieCooldown.delete(movieId);
    return { skip: false, reason: null, retryAt: null, remainingMs: 0 };
  }

  /** Xóa cooldown (dùng khi tìm được trailer thành công). */
  clearCooldown(movieId) {
    if (movieId) this.movieCooldown.delete(movieId);
  }

  // ==========================================================================
  // (đã bỏ) TMDB CIRCUIT BREAKER
  //
  // Trailer giờ CHỈ dùng YouTube Data API v3 → không còn circuit breaker riêng.
  // Toàn bộ việc chặn/giãn cách do `utils/youtubeRateLimiter.js` đảm nhiệm
  // (circuit breaker + global cooldown bám Retry-After / quota reset).
  //
  // ⭐ KEEP-STUBS: Các method dưới đây được GIỮ LẠI dưới dạng no-op để tương thích
  // với script test cũ và API cũ. KHÔNG còn ý nghĩa runtime — trailer pipeline
  // giờ là YouTube-only và KHÔNG có fallback TMDB.
  // ==========================================================================

  /** @deprecated Luôn false. Trailer pipeline không còn dùng TMDB. */
  isTmdbBlocked() {
    return false;
  }

  /** @deprecated No-op. Trailer pipeline không còn dùng TMDB. */
  tmdbRateLimited() {
    return false;
  }

  /** @deprecated No-op. Trailer pipeline không còn dùng TMDB. */
  tmdbSuccess() {
    return false;
  }

  /** @deprecated Luôn 0. Trailer pipeline không còn dùng TMDB. */
  tmdbRemainingMs() {
    return 0;
  }

  /** @deprecated Trả về object rỗng. Trailer pipeline không còn dùng TMDB. */
  getTmdbState() {
    return { blocked: false, failures: 0, openUntil: null, retryAt: null, remainingMs: 0 };
  }

  // ==========================================================================
  // 4/5. DEDUPLICATION
  // ==========================================================================

  /**
   * Đánh dấu movie vừa được xử lý.
   */
  markProcessed(movieId) {
    if (movieId) this.lastProcessedAt.set(movieId, Date.now());
  }

  /**
   * True nếu movie vừa được xử lý trong dedupe window.
   */
  isRecentlyProcessed(movieId) {
    if (!movieId) return false;
    const last = this.lastProcessedAt.get(movieId);
    if (last === undefined) return false;
    if (Date.now() - last < this.dedupeWindowMs) return true;
    this.lastProcessedAt.delete(movieId);
    return false;
  }

  /** Xem thời gian còn lại của dedupe window. */
  dedupeRemainingMs(movieId) {
    const last = this.lastProcessedAt.get(movieId);
    if (last === undefined) return 0;
    return Math.max(0, this.dedupeWindowMs - (Date.now() - last));
  }

  /** Dọn maps để tránh rò rỉ bộ nhớ. */
  prune() {
    const now = Date.now();
    // cooldown đã hết
    for (const [id, cd] of this.movieCooldown) {
      if (now >= cd.retryAtMs) this.movieCooldown.delete(id);
    }
    // dedupe đã hết
    for (const [id, at] of this.lastProcessedAt) {
      if (now - at >= this.dedupeWindowMs) this.lastProcessedAt.delete(id);
    }
    // lock stale
    for (const [id, at] of this.inFlight) {
      if (now - at >= this.lockTimeoutMs) this.inFlight.delete(id);
    }
  }

  /** Reset toàn bộ state (dùng cho test hoặc manual recovery). */
  reset() {
    this.inFlight.clear();
    this.movieCooldown.clear();
    this.lastProcessedAt.clear();
  }

  /** Snapshot tổng thể cho diagnostics endpoint. */
  stats() {
    return {
      inFlight: this.inFlight.size,
      cooldowns: this.movieCooldown.size,
      recentlyProcessed: this.lastProcessedAt.size,
      dedupeWindowMs: this.dedupeWindowMs,
    };
  }
}

// Gắn lockTimeoutMs lên prototype-level constant để dùng được ở nhiều method
TrailerState.prototype.lockTimeoutMs = parseInt(
  process.env.TRAILER_LOCK_TIMEOUT_MS || '120000', 10
); // 2 phút — đủ cho 1 vòng retry

module.exports = new TrailerState();
module.exports.TrailerState = TrailerState;
