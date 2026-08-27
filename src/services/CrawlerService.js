/**
 * CrawlerService - Bộ điều phối crawl generic
 *
 * Nhận vào một Source (OPhim / KKPhim / Nguonc...) và thực hiện:
 *   1. Lấy danh sách phim theo trang
 *   2. Lấy chi tiết từng phim (concurrency-controlled)
 *   3. Phân loại phim mới / phim cũ trong MongoDB
 *   4. Lưu phim mới + cập nhật tập mới cho phim cũ
 *   5. Backup JSON (optional)
 */

const pLimit = require('p-limit');
const Movie = require('../models/Movie');
const Category = require('../models/Category');
const logger = require('../utils/logger');
const jsonBackup = require('../utils/jsonBackup');

class CrawlerService {
  constructor(source, options = {}) {
    this.source = source;
    this.detailConcurrency = options.detailConcurrency || 5;
    this.pageDelayMs = options.pageDelayMs || 500;
    this.useMongo = options.useMongo !== false;
    this.maxEmptyPages = options.maxEmptyPages ?? 2;
  }

  async crawlPage(page = 1) {
    logger.info(`[${this.source.name()}] Crawling page ${page}...`);
    const items = await this.source.listMovies(page);
    if (items.length === 0) {
      return { savedMovies: [], updatedMovies: [], itemsFound: 0 };
    }

    const existingMap = await this._loadExistingMap(items);
    const detailMap = await this._fetchDetails(items);

    const { newItems, existingItems } = this._partition(detailMap, existingMap);

    const savedMovies = await this._saveNewMovies(newItems);
    const updatedMovies = await this._updateExistingMovies(existingItems);

    logger.info(
      `[${this.source.name()}] Page ${page}: +${savedMovies.length} new, ~${updatedMovies.length} updated`
    );
    return { savedMovies, updatedMovies, itemsFound: items.length };
  }

  async crawlAllPages(totalPages, onPage = null) {
    const result = { savedMovies: [], updatedMovies: [], errors: [], lastPage: 0 };
    let emptyStreak = 0;

    for (let page = 1; page <= totalPages; page++) {
      try {
        const { savedMovies, updatedMovies, itemsFound } = await this.crawlPage(page);
        result.savedMovies.push(...savedMovies);
        result.updatedMovies.push(...updatedMovies);
        result.lastPage = page;
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

    if (jsonBackup) {
      jsonBackup.save(this.source.name(), result);
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
        const categoryName =
          normalized.category?.[0]?.name || normalized.genre || 'Unknown';
        await Category.findOneAndUpdate(
          { name: categoryName },
          { name: categoryName },
          { upsert: true, new: true }
        );

        await Movie.findOneAndUpdate(
          { slug: normalized.slug },
          { ...normalized, _source: this.source.name(), _crawledAt: new Date() },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        saved.push(normalized.slug);
        logger.info(`Saved: ${normalized.name} (${normalized.slug})`);
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
      const result = await this._mergeEpisodes(existing, normalized.episodes || []);
      if (result.changed) {
        try {
          await Movie.findOneAndUpdate(
            { slug },
            {
              episodes: result.episodes,
              episode_current: result.episode_current,
              episode_total: result.episode_total,
              modified: { time: new Date() },
              _crawledAt: new Date(),
            }
          );
          updated.push(slug);
          logger.info(`Updated episodes: ${normalized.name} (+${result.added})`);
        } catch (err) {
          logger.error(`Update failed [${slug}]: ${err.message}`);
        }
      }
    }
    return updated;
  }

  _mergeEpisodes(existing, newEpisodes) {
    const result = {
      changed: false,
      added: 0,
      episodes: [...(existing.episodes || [])],
      episode_current: existing.episode_current,
      episode_total: existing.episode_total,
    };

    for (const newServer of newEpisodes) {
      const idx = result.episodes.findIndex((s) => s.server_name === newServer.server_name);
      if (idx === -1) {
        result.episodes.push(newServer);
        result.added += newServer.server_data?.length || 0;
        result.changed = true;
      } else {
        const exist = result.episodes[idx];
        const existSlugs = new Set(exist.server_data.map((e) => e.slug));
        const toAdd = (newServer.server_data || []).filter((e) => !existSlugs.has(e.slug));
        if (toAdd.length > 0) {
          exist.server_data = [...exist.server_data, ...toAdd];
          result.added += toAdd.length;
          result.changed = true;
        }
      }
    }

    if (result.changed) {
      let max = 0;
      for (const s of result.episodes) {
        if (s.server_data?.length > max) max = s.server_data.length;
      }
      result.episode_current = `Đã cập nhật ${max} tập`;
      result.episode_total = `${max} Tập`;
    }
    return result;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = CrawlerService;
