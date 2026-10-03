/**
 * ActorService - Business logic cho Actor
 *
 * Tách riêng khỏi MovieService để dễ bảo trì.
 * Cung cấp:
 *   - findOrCreate(name)
 *   - findOrCreateFromTMDB(tmdbPerson)        → delegate tới Actor model
 *   - findOrCreateFromWikipedia(wikiData)     → delegate tới Actor model
 *   - findOrCreateFromWikidata(wikidataData)  → NEW (ưu tiên nguồn mới)
 *   - enrichWithWikidata(actorName, opts)     → fallback khi TMDB/Wikipedia thiếu data
 *
 * Nguyên tắc (theo yêu cầu):
 *   - Ưu tiên: TMDB → Wikipedia → Wikidata → chỉ tên
 *   - Không bao giờ ghi đè dữ liệu hợp lệ bằng null/unknown
 *   - Nếu không tìm thấy: log warning, KHÔNG throw error
 *   - Không thay đổi schema Actor / không tạo collection mới
 */

const Actor = require('../models/actor');
const WikidataService = require('./WikidataService');
const logger = require('../utils/logger');

// Status code do WikidataService trả về (production-ready)
const STATUS = WikidataService.STATUS;

// Valid gender values cho Actor model (enum)
const VALID_GENDERS = new Set(['male', 'female', 'other', 'unknown']);

class ActorService {
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
   * Sinh slug từ name (giống pattern đã có ở Actor.findOrCreate).
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
   * Find or create actor cơ bản theo tên (giống Actor.findOrCreate).
   * Trả về null nếu input không hợp lệ.
   */
  async findOrCreate(name) {
    try {
      if (!name || typeof name !== 'string') return null;
      return await Actor.findOrCreate(name.trim());
    } catch (err) {
      logger.warn(`[ActorService] findOrCreate failed for "${name}": ${err.message}`);
      return null;
    }
  }

  /**
   * Find or create từ Wikidata data.
   * QUY TẮC (rất quan trọng):
   *   - Không ghi đè field hợp lệ bằng null/unknown
   *   - Nếu đã có actor (slug match), CHỈ cập nhật khi dữ liệu mới hợp lệ
   *   - Không tạo collection mới, dùng đúng schema Actor hiện tại
   *
   * @param {Object} wikidataData { qid, name, profileImage, gender }
   * @returns {Promise<Object|null>}
   */
  async findOrCreateFromWikidata(wikidataData) {
    if (!wikidataData || !wikidataData.name) return null;

    const wName = String(wikidataData.name).trim();
    const wGender = this._normalizeGender(wikidataData.gender);
    const wImage = this._isValidValue(wikidataData.profileImage)
      ? String(wikidataData.profileImage).trim()
      : null;

    try {
      const slug = this._buildSlug(wName);

      let actor = await Actor.findOne({ slug });

      if (!actor) {
        // CHƯA tồn tại → tạo mới với những field hợp lệ
        const doc = {
          name: wName,
          slug,
          source: 'wikidata',
          externalId: wikidataData.qid || '',
          isActive: true,
          movieCount: 0,
          // Defaults cho schema hiện tại
          profileImage: '',
          gender: 'unknown',
        };
        if (wImage) doc.profileImage = wImage;
        if (wGender) doc.gender = wGender;
        actor = await Actor.create(doc);
        logger.info(
          `[ActorService] ✅ Created actor from Wikidata: ${actor.name} (${actor.slug})`
        );
        return actor;
      }

      // ĐÃ tồn tại → chỉ cập nhật field khi dữ liệu mới hợp lệ
      let changed = false;

      // name: chỉ cập nhật nếu actor hiện tại thiếu/khác rõ ràng và name mới hợp lệ
      if (this._isValidValue(wName) && (!actor.name || actor.name !== wName)) {
        actor.name = wName;
        changed = true;
      }

      // profileImage: CHỈ cập nhật nếu actor chưa có ảnh hợp lệ
      if (wImage && !this._isValidValue(actor.profileImage)) {
        actor.profileImage = wImage;
        changed = true;
      }

      // gender: CHỈ cập nhật nếu actor chưa có gender hợp lệ
      if (wGender && (!this._isValidValue(actor.gender) || actor.gender === 'unknown')) {
        actor.gender = wGender;
        changed = true;
      }

      // externalId: chỉ set nếu chưa có
      if (wikidataData.qid && !actor.externalId) {
        actor.externalId = String(wikidataData.qid);
        // Không ép đổi source nếu đã là tmdb (giữ TMDB làm primary)
        if (!actor.source || actor.source === 'manual') {
          actor.source = 'wikidata';
        }
        changed = true;
      }

      if (changed) {
        await actor.save();
        logger.info(`[ActorService] ✅ Updated actor from Wikidata: ${actor.name}`);
      }
      return actor;
    } catch (err) {
      logger.warn(`[ActorService] findOrCreateFromWikidata failed for "${wName}": ${err.message}`);
      return null;
    }
  }

  /**
   * Enrich fallback bằng Wikidata.
   *
   * Phân biệt rõ ràng giữa:
   *   - OK            → tìm được, save/update actor → trả về actor doc
   *   - NOT_FOUND     → 200 OK + rỗng / 404 → trả null, KHÔNG throw
   *   - RATE_LIMITED  → 429 → giữ nguyên actor hiện tại, KHÔNG crash
   *   - SERVER_ERROR  → 5xx → giữ nguyên actor hiện tại
   *   - NETWORK_ERROR → timeout / ECONNRESET / DNS fail → giữ nguyên actor hiện tại
   *
   * @param {string} name
   * @param {Object} [opts]
   * @param {Object} [opts.currentActor] Actor doc hiện tại trong DB (nếu có) — dùng để log context
   * @param {boolean} [opts.skipIfPaused=true] Nếu queue đang pause do 429 → skip luôn, không enqueue.
   *                                          Giúp pipeline chạy tiếp các actor khác trong khi queue nghỉ.
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
        `[ActorService] Wikidata paused (${remaining}ms remaining) — skipping "${name}" (pipeline continues)`
      );
      return null;
    }

    try {
      const result = await this.wikidata.findActor(name.trim());

      // === Trường hợp OK ===
      if (result.status === STATUS.OK && result.data?.name) {
        return await this.findOrCreateFromWikidata(result.data);
      }

      // === Phân biệt rõ từng trường hợp lỗi — KHÔNG gộp thành "not found" ===

      // NOT_FOUND thật sự (200 + rỗng hoặc 404) → log warning, trả null
      if (result.status === STATUS.NOT_FOUND) {
        logger.warn(`[ActorService] Wikidata: not found for "${name}"`);
        return null;
      }

      // RATE_LIMITED → giữ actor hiện tại, KHÔNG ghi đè null/unknown
      if (result.status === STATUS.RATE_LIMITED) {
        logger.warn(
          `[ActorService] Wikidata temporarily unavailable for "${name}" (rate limited)`
        );
        return null;
      }

      // SERVER_ERROR → giữ actor hiện tại
      if (result.status === STATUS.SERVER_ERROR) {
        logger.warn(
          `[ActorService] Wikidata temporarily unavailable for "${name}" (server error)`
        );
        return null;
      }

      // NETWORK_ERROR → giữ actor hiện tại
      if (result.status === STATUS.NETWORK_ERROR) {
        logger.warn(
          `[ActorService] Wikidata temporarily unavailable for "${name}" (network error)`
        );
        return null;
      }

      // DISABLED hoặc trạng thái khác → log debug, trả null
      logger.debug(
        `[ActorService] Wikidata returned "${result.status}" for "${name}"`
      );
      return null;
    } catch (err) {
      // Catch-all: không crash, giữ actor hiện tại
      logger.warn(
        `[ActorService] enrichWithWikidata unexpected error for "${name}": ${err.message}`
      );
      return null;
    }
  }
}

module.exports = new ActorService();