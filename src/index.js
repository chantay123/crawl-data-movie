/**
 * Entry point chính - chạy nếu user gọi `npm start`
 *
 * Mặc định: crawl 1 trang từ tất cả nguồn enabled.
 * Để crawl all pages, dùng scripts/crawl-{source}-all.js
 */

const config = require('./config');
const db = require('./utils/db');
const logger = require('./utils/logger');
const CrawlerService = require('./services/CrawlerService');
const { getEnabledSources } = require('./services/SourceRegistry');

async function main() {
  const sources = getEnabledSources();
  if (sources.length === 0) {
    logger.warn('No sources enabled. Check ENABLE_* in .env');
    return;
  }

  if (process.env.SKIP_DB !== 'true') {
    await db.connect();
  }

  const page = parseInt(process.argv[2] || '1', 10);
  for (const source of sources) {
    const service = new CrawlerService(source, {
      detailConcurrency: config.crawler.detailConcurrency,
      pageDelayMs: config.crawler.pageDelayMs,
      maxEmptyPages: config.crawler.maxEmptyPages,
    });
    try {
      await service.crawlPage(page);
    } catch (err) {
      logger.error(`[${source.name()}] ${err.message}`);
    }
  }

  if (process.env.SKIP_DB !== 'true') {
    await db.disconnect();
  }
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
