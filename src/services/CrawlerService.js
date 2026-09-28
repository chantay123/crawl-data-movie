/**
 * CrawlerService - Bộ điều phối crawl generic
 *
 * Nhận vào một Source (OPhim / KKPhim / Nguonc...) và thực hiện:
 *   1. Lấy danh sách phim theo trang
 *   2. Lấy chi tiết từng phim (concurrency-controlled)
 *   3. Phân loại phim mới / phim cũ trong MongoDB (nếu useMongo=true)
 *   4. Lưu phim mới + cập nhật tập mới cho phim cũ (nếu useMongo=true)
 *   5. Backup JSON (optional)
 *
 * STANDALONE MODE (useMongo=false):
 *   - Không kết nối MongoDB
 *   - Lưu toàn bộ data vào JSON files
 *   - Hoàn toàn độc lập với backend
 */

const pLimit = require('p-limit');
const { Movie } = require('../models');
const MovieService = require('./MovieService');
const logger = require('../utils/logger');
const jsonBackup = require('../utils/jsonBackup');

class CrawlerService {
  constructor(source, options = {}) {
    this.source = source;
    this.detailConcurrency = options.detailConcurrency || 5;
    this.pageDelayMs = options.pageDelayMs || 500;
    this.useMongo = options.useMongo !== false;
    this.maxEmptyPages = options.maxEmptyPages ?? 2;
    this.standaloneMode = options.standaloneMode || false; // Full JSON backup mode
  }

  async crawlPage(page = 1) {
    logger.info(`[${this.source.name()}] Crawling page ${page}...`);
    const items = await this.source.listMovies(page);
    if (items.length === 0) {
      return { savedMovies: [], updatedMovies: [], itemsFound: 0, moviesData: [] };
    }

    // Fetch all details first
    const detailMap = await this._fetchDetails(items);

    // Standalone mode: return full data without MongoDB
    if (this.standaloneMode || !this.useMongo) {
      const moviesData = Array.from(detailMap.values());
      logger.info(
        `[${this.source.name()}] Page ${page}: ${moviesData.length} movies fetched (standalone mode)`
      );
      return { 
        savedMovies: [], 
        updatedMovies: [], 
        itemsFound: items.length,
        moviesData 
      };
    }

    // MongoDB mode: save to database
    const existingMap = await this._loadExistingMap(items);
    const { newItems, existingItems } = this._partition(detailMap, existingMap);

    const savedMovies = await this._saveNewMovies(newItems);
    const updatedMovies = await this._updateExistingMovies(existingItems);

    logger.info(
      `[${this.source.name()}] Page ${page}: +${savedMovies.length} new, ~${updatedMovies.length} updated`
    );
    return { savedMovies, updatedMovies, itemsFound: items.length, moviesData: [] };
  }

  async crawlAllPages(totalPages, onPage = null) {
    const result = { 
      savedMovies: [], 
      updatedMovies: [], 
      errors: [], 
      lastPage: 0,
      moviesData: [] // Full data for standalone mode
    };
    let emptyStreak = 0;

    for (let page = 1; page <= totalPages; page++) {
      try {
        const { savedMovies, updatedMovies, itemsFound, moviesData } = await this.crawlPage(page);
        result.savedMovies.push(...savedMovies);
        result.updatedMovies.push(...updatedMovies);
        result.lastPage = page;
        
        // Collect full data in standalone mode
        if (moviesData && moviesData.length > 0) {
          result.moviesData.push(...moviesData);
        }
        
        if (typeof onPage === 'function') onPage(page);

        if (!itemsFound) {
          emptyStreak += 1;
          if (emptyStreak >= this.maxEmptyPages) {
            logger.info(
              `[${this.source.name()}] Reached end of catalog at page ${page} after ${emptyStreak} empty pages. Stopping.`
            );
            break;
          }
        } else {
          emptyStreak = 0;
        }
      } catch (err) {
        logger.error(`[${this.source.name()}] Page ${page} failed: ${err.message}`);
        result.errors.push({ page, error: err.message });
      }
      await this._sleep(this.pageDelayMs);
    }

    // Save results to JSON
    if (jsonBackup) {
      if (this.standaloneMode && result.moviesData.length > 0) {
        // Save full data in standalone mode
        jsonBackup.saveFullData(this.source.name(), result.moviesData);
      } else {
        // Save summary in MongoDB mode
        jsonBackup.save(this.source.name(), {
          savedMovies: result.savedMovies,
          updatedMovies: result.updatedMovies,
          errors: result.errors,
          lastPage: result.lastPage,
          totalSaved: result.savedMovies.length,
          totalUpdated: result.updatedMovies.length
        });
      }
    }
    return result;
  }

  // ===== Internal =====

  async _loadExistingMap(items) {
    if (!this.useMongo) return new Map();
    const slugs = items.map((i) => i.slug).filter(Boolean);
    const docs = await Movie.find({ slug: { $in: slugs } }).lean();
    return new Map(docs.map((d) => [d.slug, d]));
  }

  async _fetchDetails(items) {
    const limit = pLimit(this.detailConcurrency);
    const tasks = items
      .filter((i) => i.slug)
      .map((item) =>
        limit(async () => {
          try {
            const raw = await this.source.getMovieDetail(item.slug);
            if (!raw) return null;
            const normalized = this.source.normalizeDetail(raw);
            if (!normalized) return null;
            return { item, normalized };
          } catch (err) {
            logger.warn(`[${this.source.name()}] Detail failed for ${item.slug}: ${err.message}`);
            return null;
          }
        })
      );
    const results = await Promise.all(tasks);
    return new Map(
      results.filter(Boolean).map((r) => [r.item.slug, r.normalized])
    );
  }

  _partition(detailMap, existingMap) {
    const newItems = [];
    const existingItems = [];
    for (const [slug, normalized] of detailMap.entries()) {
      if (existingMap.has(slug)) {
        existingItems.push({ slug, normalized, existing: existingMap.get(slug) });
      } else {
        newItems.push({ slug, normalized });
      }
    }
    return { newItems, existingItems };
  }

  async _saveNewMovies(newItems) {
    if (!this.useMongo || newItems.length === 0) return [];
    const saved = [];
    for (const { normalized } of newItems) {
      try {
        const result = await MovieService.saveMovie(normalized, this.source.name());
        saved.push(normalized.slug);
        logger.info(
          `${result.isNew ? 'Created' : 'Updated'}: ${normalized.name} (${normalized.slug})`
        );
      } catch (err) {
        logger.error(`Save failed [${normalized.slug}]: ${err.message}`);
      }
    }
    return saved;
  }

  async _updateExistingMovies(existingItems) {
    if (!this.useMongo || existingItems.length === 0) return [];
    const updated = [];
    for (const { slug, normalized, existing } of existingItems) {
      try {
        // Sử dụng MovieService để update với đầy đủ relationships
        const result = await MovieService.saveMovie(normalized, this.source.name());
        
        // Merge episodes nếu có episodes mới
        if (normalized.episodes && normalized.episodes.length > 0) {
          const mergeResult = await MovieService.updateEpisodes(
            result.movie._id, 
            normalized.episodes
          );
          if (mergeResult.changed) {
            updated.push(slug);
            logger.info(`Updated episodes: ${normalized.name} (+${mergeResult.added} episodes)`);
          }
        }
      } catch (err) {
        logger.error(`Update failed [${slug}]: ${err.message}`);
      }
    }
    return updated;
  }

  // _mergeEpisodes đã được move sang MovieService

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _generateSlug(text) {
    if (!text) return 'unknown';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 200);
  }
}

module.exports = CrawlerService;
