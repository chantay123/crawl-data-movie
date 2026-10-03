/**
 * Test thực tế cho hệ thống Actor + WikidataService đã refactor.
 *
 * Goal:
 *   - Verify concurrency = 1 / queue hoạt động (không spam 429)
 *   - Verify cache: cùng actor gọi 2 lần → chỉ 1 request
 *   - Verify 10 actor chạy tuần tự, không có 429
 *   - Verify lưu được ảnh (profileImage) + gender
 *
 * Usage: node scripts/test-wikidata-actor-refactor.js [N_ACTORS]
 *   Default N_ACTORS = 12
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.LOG_LEVEL = 'info';

const mongoose = require('mongoose');
const path = require('path');
const Actor = require('../src/models/actor');
const WikidataService = require('../src/services/WikidataService');
const ActorService = require('../src/services/ActorService');
const logger = require('../src/utils/logger');

// 12 actor đa dạng: Việt Nam + quốc tế, có thực + edge cases
const TEST_ACTORS = [
  'Mã Quốc Minh',
  'Trấn Thành',
  'Ngô Thanh Vân',
  'Tom Holland',
  'Scarlett Johansson',
  'Robert Downey Jr.',
  'Chris Evans',
  'Mark Ruffalo',
  'Chris Hemsworth',
  'Jeremy Renner',
  'Tom Hiddleston',
  'Cillian Murphy',
];

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/moviestreaming';
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });
  logger.info(`[Test] ✅ Connected to MongoDB: ${mongoUri}`);
}

async function cleanupBySlugs(slugs) {
  const res = await Actor.deleteMany({ slug: { $in: slugs } });
  if (res.deletedCount > 0) {
    logger.info(`[Test] 🧹 Cleaned up ${res.deletedCount} test actors`);
  }
}

async function main() {
  const nActors = parseInt(process.argv[2] || '12', 10);
  const actors = TEST_ACTORS.slice(0, nActors);
  const slugs = actors.map(n => ActorService._buildSlug(n));

  logger.info(`\n========== TEST START: ${actors.length} actors ==========\n`);

  await connectDB();
  await cleanupBySlugs(slugs);

  // === Reset cache + queue ===
  WikidataService.clearCache();
  WikidataService.pausedUntil = 0; // reset pause từ test trước

  // === Mark start time ===
  const t0 = Date.now();

  // === Test 1: Cache miss → phải thấy 1 "Request" log per actor ===
  logger.info('\n========== Test 1: Cache miss (sequential) ==========');
  const seenRequests = [];
  const seenHits = [];

  // Spy log
  const originalInfo = logger.info.bind(logger);
  logger.info = (...args) => {
    const msg = String(args[0] || '');
    if (msg.includes('[Wikidata] Request:')) seenRequests.push(msg);
    if (msg.includes('Cache hit for')) seenHits.push(msg);
    originalInfo(...args);
  };

  for (const name of actors) {
    const result = await ActorService.enrichWithWikidata(name);
    logger.info(
      `[Test] Actor "${name}": status=${result ? 'OK' : 'SKIP'}`
    );
  }

  const elapsed1 = Date.now() - t0;
  logger.info(
    `\n[Test] Test 1 done in ${elapsed1}ms (${(elapsed1 / actors.length).toFixed(0)}ms/actor avg)`
  );

  // === Test 2: Cache hit → chạy lại cùng tên, KHÔNG gọi API nữa ===
  logger.info('\n========== Test 2: Cache hit (same names, should NOT call API) ==========');
  const t1 = Date.now();

  for (const name of actors) {
    const result = await ActorService.enrichWithWikidata(name);
    logger.info(`[Test] Actor "${name}" (2nd call): ${result ? 'OK' : 'SKIP'}`);
  }

  const elapsed2 = Date.now() - t1;
  logger.info(`[Test] Test 2 done in ${elapsed2}ms`);

  // === Restore logger ===
  logger.info = originalInfo;

  // === Verify DB ===
  logger.info('\n========== Verify DB ==========');
  const dbActors = await Actor.find({ slug: { $in: slugs } });
  logger.info(`[Test] Found ${dbActors.length} actors in DB`);

  let withImage = 0, withGender = 0, imageSamples = [];
  for (const a of dbActors) {
    if (a.profileImage && a.profileImage.trim()) {
      withImage++;
      imageSamples.push({ name: a.name, img: a.profileImage });
    }
    if (a.gender && a.gender !== 'unknown') {
      withGender++;
    }
    logger.info(
      `  - ${a.name} | image=${a.profileImage ? '✅' : '❌'} | gender=${a.gender} | source=${a.source}`
    );
  }

  // === Stats ===
  const stats = WikidataService.getStats();
  logger.info('\n========== WikidataService Stats ==========');
  logger.info(JSON.stringify(stats, null, 2));

  // === Verify request count vs actor count ===
  const seenUnique = new Set(seenRequests.map(s => s.toLowerCase())).size;
  logger.info(`\n========== Analysis ==========`);
  logger.info(`Unique actor requests sent: ${seenUnique}`);
  logger.info(`Cache hits observed: ${seenHits.length}`);
  logger.info(`Total cacheMiss (Test 1) calls: ${stats.cacheMisses}`);
  logger.info(`Total cacheHits (Test 1+2) calls: ${stats.cacheHits}`);

  // === Cleanup ===
  await cleanupBySlugs(slugs);
  await mongoose.disconnect();

  logger.info('\n========== DONE ==========');
}

main().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});