/**
 * Crawl Nguonc - 1 trang (mặc định page=1)
 *
 * Usage: node scripts/crawl-nguonc.js [page]
 */

const CrawlerService = require('../src/services/CrawlerService');
const NguoncSource = require('../src/sources/NguoncSource');
const db = require('../src/utils/db');
const config = require('../src/config');
const logger = require('../src/utils/logger');

async function main() {
  const page = parseInt(process.argv[2] || '1', 10);
  await db.connect();

  const source = new NguoncSource(config.sources.nguonc);
  logger.info(`Base URL: ${source.baseUrl}`);

  // Test nhanh listMovies
  const list = await source.listMovies(page);
  logger.info(`Found ${list.length} movies on page ${page}`);
  if (list.length > 0) {
    logger.info(`First movie: ${JSON.stringify(list[0])}`);
    // Test detail movie đầu tiên
    const detail = await source.getMovieDetail(list[0].slug);
    if (detail) {
      const normalized = source.normalizeDetail(detail);
      logger.info(`Detail sample: ${JSON.stringify({
        name: normalized?.name,
        slug: normalized?.slug,
        episodes: normalized?.episodes?.length,
        actor_count: normalized?.actor?.length,
        category_count: normalized?.category?.length,
      }, null, 2)}`);
    }
  }

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
  console.error(err.stack);
  process.exit(1);
});
