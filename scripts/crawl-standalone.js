/**
 * Standalone Crawler - No MongoDB Required
 * 
 * Crawl movies và lưu toàn bộ data vào JSON files
 * Hoàn toàn độc lập, không cần backend hay MongoDB
 * 
 * Usage:
 *   node scripts/crawl-standalone.js [source] [pages]
 * 
 * Examples:
 *   node scripts/crawl-standalone.js ophim 5
 *   node scripts/crawl-standalone.js kkphim 10
 *   node scripts/crawl-standalone.js nguonc 3
 *   node scripts/crawl-standalone.js all 5
 */

require('dotenv').config();
const logger = require('../src/utils/logger');
const CrawlerService = require('../src/services/CrawlerService');
const { getEnabledSources, getSource } = require('../src/services/SourceRegistry');
const config = require('../src/config');

async function crawlStandalone(sourceName, pages) {
  logger.info(`🚀 Starting STANDALONE crawler (no MongoDB)`);
  logger.info(`   Source: ${sourceName}`);
  logger.info(`   Pages: ${pages}`);
  logger.info(`   Output: ${config.output.jsonDir}`);
  logger.info(`   Mode: Full data export to JSON`);
  
  const sources = sourceName === 'all' 
    ? getEnabledSources() 
    : [getSource(sourceName)];

  if (!sources || sources.length === 0) {
    logger.error(`❌ No valid source found: ${sourceName}`);
    logger.info('Available sources: ophim, kkphim, nguonc, all');
    process.exit(1);
  }

  const startTime = Date.now();
  const allResults = [];

  for (const source of sources) {
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`📡 Crawling ${source.name().toUpperCase()}`);
    logger.info(`${'='.repeat(60)}`);

    const service = new CrawlerService(source, {
      detailConcurrency: config.crawler.detailConcurrency,
      pageDelayMs: config.crawler.pageDelayMs,
      maxEmptyPages: config.crawler.maxEmptyPages,
      useMongo: false,           // Disable MongoDB
      standaloneMode: true        // Enable full data export
    });

    try {
      const result = await service.crawlAllPages(pages, (page) => {
        logger.info(`[${source.name()}] Completed page ${page}/${pages}`);
      });

      const stats = {
        source: source.name(),
        pagesProcessed: result.lastPage,
        moviesCollected: result.moviesData.length,
        errors: result.errors.length
      };

      allResults.push(stats);

      logger.info(`\n✅ ${source.name()} completed:`);
      logger.info(`   Pages processed: ${stats.pagesProcessed}`);
      logger.info(`   Movies collected: ${stats.moviesCollected}`);
      logger.info(`   Errors: ${stats.errors}`);

    } catch (err) {
      logger.error(`❌ ${source.name()} failed: ${err.message}`);
      allResults.push({
        source: source.name(),
        error: err.message
      });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`🎉 CRAWL COMPLETED`);
  logger.info(`${'='.repeat(60)}`);
  logger.info(`Time elapsed: ${elapsed}s`);
  logger.info(`Total sources: ${allResults.length}`);
  logger.info(`Output directory: ${config.output.jsonDir}`);
  
  allResults.forEach(stat => {
    if (stat.error) {
      logger.info(`   ❌ ${stat.source}: ${stat.error}`);
    } else {
      logger.info(`   ✅ ${stat.source}: ${stat.moviesCollected} movies`);
    }
  });
  
  logger.info(`\n💡 Data saved to: ${config.output.jsonDir}`);
  logger.info(`   Files: ${sourceName}-full-*.json`);
}

// Parse CLI arguments
const args = process.argv.slice(2);
const sourceName = args[0] || 'all';
const pages = parseInt(args[1] || '5', 10);

if (isNaN(pages) || pages < 1) {
  logger.error('❌ Invalid pages number. Must be >= 1');
  process.exit(1);
}

crawlStandalone(sourceName, pages)
  .then(() => {
    logger.info('\n✅ Process completed successfully');
    process.exit(0);
  })
  .catch((err) => {
    logger.error(`\n❌ Fatal error: ${err.message}`);
    logger.error(err.stack);
    process.exit(1);
  });
