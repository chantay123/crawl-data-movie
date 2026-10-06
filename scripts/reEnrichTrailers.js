/**
 * reEnrichTrailers.js
 *
 * Re-fetch trailer cho movies đang thiếu trailer, dùng YouTube Data API v3.
 *
 * ⭐ TMDB đã bị gỡ khỏi flow trailer (yêu cầu #1).
 *    YouTube là nguồn trailer DUY NHẤT.
 *
 * Logic (BATCH + DELAY + COOLDOWN — yêu cầu #1-#11):
 *   - TrailerService.batchUpdateTrailers() chạy SEQUENTIAL, mỗi batch 10 phim
 *     (mặc định), 60s pause giữa batch, 3-8s delay giữa phim, 30-min cooldown
 *     khi gặp 429.
 *
 * Usage:
 *   node scripts/reEnrichTrailers.js
 *   node scripts/reEnrichTrailers.js --limit=50 --batch-size=20
 *   node scripts/reEnrichTrailers.js --dry-run
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const config = require('../src/config');
const TrailerService = require('../src/services/TrailerService');
const YouTubeService = require('../src/services/YouTubeService');

function parseArg(name, def) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!arg) return def;
  const v = parseInt(arg.split('=')[1], 10);
  return Number.isFinite(v) ? v : def;
}

async function reEnrichTrailers() {
  // Parse args
  const limit = parseArg('limit', 0);    // 0 = use config default
  const batchSize = parseArg('batch-size', 10);
  const dryRun = process.argv.includes('--dry-run');

  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  console.log('🔗 Connected to MongoDB\n');

  console.log('=== CONFIG ===');
  console.log('  YouTube enabled :', YouTubeService.enabled);
  console.log('  YouTube isAvailable :', YouTubeService.isAvailable());
  console.log('  limit           :', limit || '(config default)');
  console.log('  batchSize       :', batchSize);
  console.log('  dryRun          :', dryRun);
  console.log('');

  if (!YouTubeService.enabled) {
    console.log('❌ YouTube chưa bật. Set ENABLE_YOUTUBE_TRAILER=true và YOUTUBE_API_KEY trong .env');
    await mongoose.disconnect();
    return;
  }

  // ⭐ Dùng batchUpdateTrailers của TrailerService (đã handle rate-limit + dedupe + circuit)
  if (dryRun) {
    console.log('🧪 DRY RUN — chỉ liệt kê movies cần re-enrich, không fetch');
    const db = mongoose.connection.db;
    const movies = await db.collection('movies').find({
      $or: [
        { trailer: { $exists: false } },
        { trailer: null },
        { 'trailer.key': '' },
        { 'trailer.key': null },
      ],
    }).limit(limit).toArray();
    console.log(`📊 Tìm thấy ${movies.length} movies cần re-enrich trailer (cap ở limit=${limit})`);
    movies.forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.name} (slug=${m.slug}, year=${m.releaseDate ? new Date(m.releaseDate).getFullYear() : 'N/A'})`);
    });
    await mongoose.disconnect();
    return;
  }

  // Run batch
  const stats = await TrailerService.batchUpdateTrailers({
    batchSize,
    limit: limit > 0 ? limit : undefined,
  });

  console.log('\n========================================');
  console.log('📊 KẾT QUẢ');
  console.log('========================================');
  console.log(`  total          : ${stats.total}`);
  console.log(`  batches        : ${stats.batches || 0}`);
  console.log(`  found          : ${stats.found}`);
  console.log(`  rateLimited    : ${stats.rateLimited}`);
  console.log(`  notFound       : ${stats.notFound}`);
  console.log(`  errors         : ${stats.errors}`);
  console.log(`  skipped        : ${stats.skipped}`);
  console.log(`  cooldowns      : ${stats.cooldowns}`);
  if (stats.deferred) console.log(`  deferred       : YES (circuit OPEN — sẽ retry sau cooldown)`);
  console.log('========================================\n');

  await mongoose.disconnect();
}

reEnrichTrailers().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
