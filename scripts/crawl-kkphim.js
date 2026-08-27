/**
 * Crawl KKPhim - tất cả trang
 *
 * Usage: node scripts/crawl-kkphim.js [totalPages]
 */

const CrawlerService = require('../src/services/CrawlerService');
const KKPhimSource = require('../src/sources/KKPhimSource');
const db = require('../src/utils/db');
const config = require('../src/config');
const logger = require('../src/utils/logger');

async function main() {
  const totalPages = parseInt(process.argv[2] || config.crawler.totalPages, 10);
  await db.connect();

  const source = new KKPhimSource(config.sources.kkphim);
  const service = new CrawlerService(source, {
    detailConcurrency: config.crawler.detailConcurrency,
    pageDelayMs: config.crawler.pageDelayMs,
    maxEmptyPages: config.crawler.maxEmptyPages,
  });

  const result = await service.crawlAllPages(totalPages);
  logger.info(`KKPhim done. New=${result.savedMovies.length}, Updated=${result.updatedMovies.length}`);

  await db.disconnect();
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
