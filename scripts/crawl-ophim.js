/**
 * Crawl OPhim - 1 trang (mặc định page=1)
 *
 * Usage: node scripts/crawl-ophim.js [page]
 */

const CrawlerService = require('../src/services/CrawlerService');
const OPhimSource = require('../src/sources/OPhimSource');
const db = require('../src/utils/db');
const config = require('../src/config');
const logger = require('../src/utils/logger');

async function main() {
  const page = parseInt(process.argv[2] || '1', 10);
  await db.connect();

  const source = new OPhimSource(config.sources.ophim);
  const service = new CrawlerService(source, {
    detailConcurrency: config.crawler.detailConcurrency,
    pageDelayMs: config.crawler.pageDelayMs,
    maxEmptyPages: config.crawler.maxEmptyPages,
  });

  const result = await service.crawlPage(page);
  logger.info(`Done. New=${result.savedMovies.length}, Updated=${result.updatedMovies.length}`);

  await db.disconnect();
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
