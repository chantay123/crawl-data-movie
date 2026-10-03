/**
 * reEnrichTrailers.js
 *
 * Re-fetch trailer cho movies đang thiếu trailer, dùng YouTube Data API v3.
 *
 * ⭐ TMDB đã bị gỡ khỏi flow trailer (yêu cầu #1).
 *    YouTube là nguồn trailer DUY NHẤT.
 *
 * Logic:
 *   - Tìm movies có `trailer = null` hoặc `trailer.key` rỗng
 *   - Với mỗi movie, gọi TrailerService.getTrailer() với force=true
 *   - In kết quả và rate-limit tracking
 *
 * Usage: node scripts/reEnrichTrailers.js [--limit=N] [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const config = require('../src/config');
const TrailerService = require('../src/services/TrailerService');
const YouTubeService = require('../src/services/YouTubeService');

async function reEnrichTrailers() {
  // Parse args
  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 50;
  const dryRun = args.includes('--dry-run');

  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  console.log('🔗 Connected to MongoDB\n');

  console.log('=== CONFIG ===');
  console.log('  YouTube enabled :', YouTubeService.enabled);
  console.log('  YouTube isAvailable :', YouTubeService.isAvailable());
  console.log('  limit           :', limit);
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
  const stats = await TrailerService.batchUpdateTrailers(limit);

  console.log('\n========================================');
  console.log('📊 KẾT QUẢ');
  console.log('========================================');
  console.log(`  total        : ${stats.total}`);
  console.log(`  found        : ${stats.found}`);
  console.log(`  rateLimited  : ${stats.rateLimited}`);
  console.log(`  notFound     : ${stats.notFound}`);
  console.log(`  errors       : ${stats.errors}`);
  console.log(`  skipped      : ${stats.skipped}`);
  if (stats.deferred) console.log(`  deferred     : YES (circuit OPEN — sẽ retry sau cooldown)`);
  console.log('========================================\n');

  await mongoose.disconnect();
}

reEnrichTrailers().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
