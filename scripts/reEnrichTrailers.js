/**
 * reEnrichTrailers.js
 *
 * Re-fetch trailer cho movies đang thiếu trailer, dùng YouTube Data API v3.
 *
 * ⭐ TMDB đã bị gỡ khỏi flow trailer (yêu cầu #1).
 *    YouTube là nguồn trailer DUY NHẤT.
 *
 * Logic (BATCH + DELAY + COOLDOWN + CHECKPOINT — yêu cầu #1-#14):
 *   - TrailerService.batchUpdateTrailers() chạy SEQUENTIAL, mỗi batch 10 phim
 *     (mặc định), 60s pause giữa batch, 5-10s delay giữa phim, 30-min cooldown
 *     khi gặp 429.
 *   - Persistent checkpoint (MongoDB) — resume khi server restart / QUOTA_EXCEEDED.
 *
 * Usage:
 *   node scripts/reEnrichTrailers.js
 *   node scripts/reEnrichTrailers.js --limit=50 --batch-size=20
 *   node scripts/reEnrichTrailers.js --job-id=nightly --force-restart
 *   node scripts/reEnrichTrailers.js --no-resume
 *   node scripts/reEnrichTrailers.js --status
 *   node scripts/reEnrichTrailers.js --dry-run
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const config = require('../src/config');
const TrailerService = require('../src/services/TrailerService');
const YouTubeService = require('../src/services/YouTubeService');
const trailerCheckpoint = require('../src/utils/trailerCheckpoint');

function parseArg(name, def) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!arg) return def;
  return arg.split('=').slice(1).join('=');
}

function parseIntArg(name, def) {
  const v = parseArg(name, def);
  if (v === def) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

async function showStatus(jobId) {
  console.log('='.repeat(60));
  console.log(`🔍 CHECKPOINT STATUS for jobId="${jobId}"`);
  console.log('='.repeat(60));
  const cp = await trailerCheckpoint.get(jobId);
  if (!cp) {
    console.log('   (no checkpoint found)');
  } else {
    console.log(`   status              : ${cp.status}`);
    console.log(`   currentMovieId      : ${cp.currentMovieId || '(null)'}`);
    console.log(`   currentIndex        : ${cp.currentIndex}`);
    console.log(`   totalMovies         : ${cp.totalMovies}`);
    console.log(`   lastProcessedMovieId: ${cp.lastProcessedMovieId || '(null)'}`);
    console.log(`   lastProcessedIndex  : ${cp.lastProcessedIndex}`);
    console.log(`   quotaExceededAt     : ${cp.quotaExceededAt ? new Date(cp.quotaExceededAt).toISOString() : '(null)'}`);
    console.log(`   resumeAt            : ${cp.resumeAt ? new Date(cp.resumeAt).toISOString() : '(null)'}`);
    console.log(`   updatedAt           : ${new Date(cp.updatedAt).toISOString()}`);
    if (cp.stats) {
      console.log(`   stats               : found=${cp.stats.found}, notFound=${cp.stats.notFound}, ` +
                  `rateLimited=${cp.stats.rateLimited}, errors=${cp.stats.errors}, skipped=${cp.stats.skipped}`);
    }
  }
  console.log('='.repeat(60));
}

async function reEnrichTrailers() {
  // Parse args
  const limit = parseIntArg('limit', 0);    // 0 = use config default
  const batchSize = parseIntArg('batch-size', 10);
  const jobId = parseArg('job-id', 'default');
  const forceRestart = process.argv.includes('--force-restart');
  const noResume = process.argv.includes('--no-resume');
  const statusOnly = process.argv.includes('--status');
  const dryRun = process.argv.includes('--dry-run');

  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  console.log('🔗 Connected to MongoDB\n');

  console.log('=== CONFIG ===');
  console.log('  YouTube enabled   :', YouTubeService.enabled);
  console.log('  YouTube isAvailable :', YouTubeService.isAvailable());
  console.log('  jobId             :', jobId);
  console.log('  limit             :', limit || '(config default)');
  console.log('  batchSize         :', batchSize);
  console.log('  resume            :', !noResume);
  console.log('  forceRestart      :', forceRestart);
  console.log('  dryRun            :', dryRun);
  console.log('');

  if (!YouTubeService.enabled) {
    console.log('❌ YouTube chưa bật. Set ENABLE_YOUTUBE_TRAILER=true và YOUTUBE_API_KEY trong .env');
    await mongoose.disconnect();
    return;
  }

  if (statusOnly) {
    await showStatus(jobId);
    await mongoose.disconnect();
    return;
  }

  // ⭐ Dùng batchUpdateTrailers của TrailerService (đã handle rate-limit + dedupe + circuit + checkpoint)
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
    jobId,
    forceRestart,
    resume: !noResume,
  });

  console.log('\n========================================');
  console.log('📊 KẾT QUẢ');
  console.log('========================================');
  console.log(`  jobId        : ${stats.jobId}`);
  console.log(`  status       : ${stats.status}`);
  console.log(`  currentIndex : ${stats.currentIndex}/${stats.totalMovies}`);
  console.log(`  total        : ${stats.total}`);
  console.log(`  batches      : ${stats.batches || 0}`);
  console.log(`  found        : ${stats.found}`);
  console.log(`  rateLimited  : ${stats.rateLimited}`);
  console.log(`  notFound     : ${stats.notFound}`);
  console.log(`  errors       : ${stats.errors}`);
  console.log(`  skipped      : ${stats.skipped}`);
  console.log(`  cooldowns    : ${stats.cooldowns}`);
  if (stats.deferred) console.log(`  deferred     : YES (circuit OPEN — sẽ retry sau cooldown)`);
  if (stats.quotaExceeded) {
    console.log(`  ⛔ QUOTA_EXCEEDED — checkpoint saved`);
    console.log(`     Resume at    : ${stats.quotaResetAt ? new Date(stats.quotaResetAt).toISOString() : 'unknown'}`);
    console.log(`     Resume from  : index=${stats.currentIndex}`);
  }
  console.log('========================================\n');

  await mongoose.disconnect();
}

reEnrichTrailers().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
