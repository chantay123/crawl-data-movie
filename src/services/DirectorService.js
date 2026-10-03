/**
 * DirectorService - Business logic cho Director
 *
 * Tách riêng khỏi MovieService / ActorService để dễ bảo trì.
 * Cung cấp:
 *   - findOrCreate(name)
 *   - findOrCreateFromWikidata(wikidataData)  → idempotent theo (externalId + source='wikidata')
 *   - enrichWithWikidata(name, opts)          → fallback khi TMDB/Wikipedia thiếu data
 *
 * Nguyên tắc:
 *   - Ưu tiên: TMDB → Wikipedia → Wikidata → chỉ tên
 *   - Không bao giờ ghi đè dữ liệu hợp lệ bằng null/unknown
 *   - Nếu không tìm thấy: log warning, KHÔNG throw error
 *   - Không thay đổi schema Director / không tạo collection mới
 *
 * Đồng bộ với ActorService — dùng chung WikidataService singleton
 * (chia sẻ queue + cache + rate-limit giữa Actor và Director).
 */

const Director = require('../models/director');
const WikidataService = require('./WikidataService');
const logger = require('../utils/logger');

// Status code do WikidataService trả về
const STATUS = WikidataService.STATUS;

// Valid gender values cho Director model (enum)
const VALID_GENDERS = new Set(['male', 'female', 'other', 'unknown']);

class DirectorService {
  constructor() {
    this.wikidata = WikidataService;
  }

  /**
   * Helper: validate + chuẩn hoá giá trị gender.
   * @param {string} gender
   * @returns {string|null} 'male' | 'female' | 'other' | 'unknown' | null
   */
  _normalizeGender(gender) {
    if (!gender) return null;
    const g = String(gender).toLowerCase().trim();
    if (VALID_GENDERS.has(g)) return g;
    return null;
  }

  /**
   * Helper: kiểm tra 1 giá trị có "hợp lệ" hay không
   * (không null / undefined / empty string / 'unknown').
   * @param {*} v
   * @returns {boolean}
   */
  _isValidValue(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return false;
      if (s.toLowerCase() === 'unknown') return false;
    }
    return true;
  }

  /**
   * Sinh slug từ name (mirror ActorService / Director.findOrCreate).
   */
  _buildSlug(name) {
    return String(name)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }

  /**
   * Find or create director cơ bản theo tên (mirror Director.findOrCreate).
   * Trả về null nếu input không hợp lệ.
   */
  async findOrCreate(name) {
    try {
      if (!name || typeof name !== 'string') return null;
      return await Director.findOrCreate(name.trim());
    } catch (err) {
      logger.warn(`[DirectorService] findOrCreate failed for "${name}": ${err.message}`);
      return null;
    }
  }

  /**
   * Find or create từ Wikidata data.
   * Ủy quyền cho model Director.findOrCreateFromWikidata (idempotent theo externalId + source).
   *
   * @param {Object} wikidataData { qid, name, profileImage, gender, dateOfBirth }
   * @returns {Promise<Object|null>}
   */
  async findOrCreateFromWikidata(wikidataData) {
    if (!wikidataData || !wikidataData.name) return null;

    try {
      const director = await Director.findOrCreateFromWikidata(wikidataData);
      if (director) {
        logger.info(
          `[DirectorService] ✅ Director from Wikidata: ${director.name} (${director.slug}, qid=${director.externalId || 'n/a'})`
        );
      }
      return director;
    } catch (err) {
      logger.warn(
        `[DirectorService] findOrCreateFromWikidata failed for "${wikidataData.name}": ${err.message}`
      );
      return null;
    }
  }

  /**
   * Enrich fallback bằng Wikidata.
   *
   * Phân biệt rõ ràng giữa:
   *   - OK            → tìm được, save/update director → trả về director doc
   *   - NOT_FOUND     → 200 OK + rỗng / 404 → trả null, KHÔNG throw
   *   - RATE_LIMITED  → 429 → giữ nguyên director hiện tại, KHÔNG crash
   *   - SERVER_ERROR  → 5xx → giữ nguyên director hiện tại
   *   - NETWORK_ERROR → timeout / ECONNRESET / DNS fail → giữ nguyên director hiện tại
   *
   * @param {string} name
   * @param {Object} [opts]
   * @param {Object} [opts.currentDirector] Director doc hiện tại trong DB (nếu có) — dùng để log context
   * @param {boolean} [opts.skipIfPaused=true] Nếu queue đang pause do 429 → skip luôn, không enqueue.
   *                                            Giúp pipeline chạy tiếp các director khác trong khi queue nghỉ.
   * @returns {Promise<Object|null>}
   */
  async enrichWithWikidata(name, opts = {}) {
    if (!name || typeof name !== 'string') return null;
    if (!this.wikidata.enabled) return null;

    const skipIfPaused = opts.skipIfPaused !== false; // default true

    // === Skip khi queue đang pause (429) — không enqueue để tránh pipeline bị block hàng giờ ===
    if (skipIfPaused && typeof this.wikidata.isPaused === 'function' && this.wikidata.isPaused()) {
      const remaining = this.wikidata.pausedRemainingMs();
      logger.debug(
        `[DirectorService] Wikidata paused (${remaining}ms remaining) — skipping director "${name}" (pipeline continues)`
      );
      return null;
    }

    try {
      const result = await this.wikidata.findDirector(name.trim());

      // === Trường hợp OK ===
      if (result.status === STATUS.OK && result.data?.name) {
        return await this.findOrCreateFromWikidata(result.data);
      }

      // === Phân biệt rõ từng trường hợp lỗi — KHÔNG gộp thành "not found" ===

      // NOT_FOUND thật sự → log warning, trả null
      if (result.status === STATUS.NOT_FOUND) {
        logger.debug(`[DirectorService] Wikidata: director not found for "${name}"`);
        return null;
      }

      // RATE_LIMITED → giữ director hiện tại, KHÔNG ghi đè null/unknown
      if (result.status === STATUS.RATE_LIMITED) {
        logger.warn(
          `[DirectorService] Wikidata temporarily unavailable for director "${name}" (rate limited)`
        );
        return null;
      }

      // SERVER_ERROR → giữ director hiện tại
      if (result.status === STATUS.SERVER_ERROR) {
        logger.warn(
          `[DirectorService] Wikidata temporarily unavailable for director "${name}" (server error)`
        );
        return null;
      }

      // NETWORK_ERROR → giữ director hiện tại
      if (result.status === STATUS.NETWORK_ERROR) {
        logger.warn(
          `[DirectorService] Wikidata temporarily unavailable for director "${name}" (network error)`
        );
        return null;
      }

      // DISABLED hoặc trạng thái khác → log debug, trả null
      logger.debug(
        `[DirectorService] Wikidata returned "${result.status}" for director "${name}"`
      );
      return null;
    } catch (err) {
      // Catch-all: không crash, giữ director hiện tại
      logger.warn(
        `[DirectorService] enrichWithWikidata unexpected error for director "${name}": ${err.message}`
      );
      return null;
    }
  }
}

module.exports = new DirectorService();