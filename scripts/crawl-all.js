/**
 * Crawl TẤT CẢ nguồn đang bật (chạy tuần tự từng nguồn)
 *
 * Usage: node scripts/crawl-all.js
 */

const config = require('../src/config');
const db = require('../src/utils/db');
const logger = require('../src/utils/logger');
const CrawlerService = require('../src/services/CrawlerService');
const { getEnabledSources } = require('../src/services/SourceRegistry');

async function main() {
  const sources = getEnabledSources();
  if (sources.length === 0) {
    logger.warn('No sources enabled. Set ENABLE_*=true in .env');
    return;
  }

  await db.connect();

  const totalPages = config.crawler.totalPages;
  for (const source of sources) {
    logger.info(`========== Source: ${source.name()} ==========`);
    const service = new CrawlerService(source, {
      detailConcurrency: config.crawler.detailConcurrency,
      pageDelayMs: config.crawler.pageDelayMs,
      maxEmptyPages: config.crawler.maxEmptyPages,
    });
    const result = await service.crawlAllPages(totalPages);
    logger.info(`${source.name()}: New=${result.savedMovies.length}, Updated=${result.updatedMovies.length}`);
  }

  await db.disconnect();
  logger.info('All sources completed.');
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
