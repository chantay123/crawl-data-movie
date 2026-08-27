/**
 * Crawl OPhim - TẤT CẢ 1500 trang (tuần tự, có delay)
 *
 * Usage: node scripts/crawl-ophim-all.js [totalPages]
 */

const CrawlerService = require('../src/services/CrawlerService');
const OPhimSource = require('../src/sources/OPhimSource');
const db = require('../src/utils/db');
const config = require('../src/config');
const logger = require('../src/utils/logger');

async function main() {
  const totalPages = parseInt(process.argv[2] || config.crawler.totalPages, 10);
  logger.info(`Starting crawl: ${totalPages} pages`);

  await db.connect();

  const source = new OPhimSource(config.sources.ophim);
  const service = new CrawlerService(source, {
    detailConcurrency: config.crawler.detailConcurrency,
    pageDelayMs: config.crawler.pageDelayMs,
    maxEmptyPages: config.crawler.maxEmptyPages,
  });

  const result = await service.crawlAllPages(totalPages);
  logger.info(`FINISHED. New=${result.savedMovies.length}, Updated=${result.updatedMovies.length}, Errors=${result.errors.length}`);

  await db.disconnect();
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
