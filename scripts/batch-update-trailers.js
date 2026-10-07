/**
 * Batch Update Trailers
 * Script để cập nhật trailer cho tất cả movies có TMDB ID nhưng chưa có trailer
 *
 * ⭐ BATCH + DELAY + COOLDOWN + CHECKPOINT (yêu cầu #1-#14):
 *   - Sequential, batch size mặc định 10, 60s pause giữa batch,
 *     5-10s delay giữa phim, 30-min cooldown khi gặp 429.
 *   - Persistent checkpoint (MongoDB) — resume khi server restart / QUOTA_EXCEEDED.
 *
 * Usage:
 *   node scripts/batch-update-trailers.js
 *   node scripts/batch-update-trailers.js 50          (max movies cap, legacy)
 *   node scripts/batch-update-trailers.js 50 20       (max=50, batchSize=20)
 *   node scripts/batch-update-trailers.js --job-id=nightly-2026-10-07
 *   node scripts/batch-update-trailers.js --force-restart
 *   node scripts/batch-update-trailers.js --no-resume
 *   node scripts/batch-update-trailers.js --status   (chỉ in checkpoint hiện tại)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TrailerService = require('../src/services/TrailerService');
const trailerCheckpoint = require('../src/utils/trailerCheckpoint');
const logger = require('../src/utils/logger');

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

async function batchUpdateTrailers() {
  try {
    console.log('='.repeat(60));
    console.log('🎬 BATCH UPDATE TRAILERS');
    console.log('='.repeat(60));
    console.log('');

    // Connect to MongoDB
    console.log('📦 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected\n');

    // Get config from CLI (legacy positional args + new --batch-size, --job-id, ...)
    const positional = process.argv.slice(2).filter(a => /^\d+$/.test(a));
    const limit = positional[0] ? parseInt(positional[0], 10) : 0;
    const batchSize = parseIntArg('batch-size',
      positional[1] ? parseInt(positional[1], 10) : 10
    );
    const jobId = parseArg('job-id', 'default');
    const forceRestart = process.argv.includes('--force-restart');
    const noResume = process.argv.includes('--no-resume');
    const statusOnly = process.argv.includes('--status');

    console.log(`📦 jobId       : ${jobId}`);
    console.log(`📦 maxMovies   : ${limit || '(default from config)'}`);
    console.log(`📦 batchSize   : ${batchSize} (allowed: 10/20/30/40)`);
    console.log(`📦 resume      : ${!noResume}`);
    console.log(`📦 forceRestart: ${forceRestart}\n`);

    if (statusOnly) {
      await showStatus(jobId);
      return;
    }

    // Run batch update
    console.log('📦 Starting batch update...\n');
    const stats = await TrailerService.batchUpdateTrailers({
      batchSize,
      limit: limit > 0 ? limit : undefined,
      jobId,
      forceRestart,
      resume: !noResume,
    });

    // Display results
    console.log('\n' + '='.repeat(60));
    console.log('✅ BATCH UPDATE COMPLETED');
    console.log('='.repeat(60));
    console.log(`   jobId         : ${stats.jobId}`);
    console.log(`   status        : ${stats.status}`);
    console.log(`   currentIndex  : ${stats.currentIndex}/${stats.totalMovies}`);
    console.log(`   Total processed : ${stats.total}`);
    console.log(`   Batches         : ${stats.batches || 0}`);
    console.log(`   ✅ Success      : ${stats.found}`);
    console.log(`   ⛔ Rate limited : ${stats.rateLimited}`);
    console.log(`   ⚠️  Not found   : ${stats.notFound}`);
    console.log(`   ⏭  Skipped     : ${stats.skipped}`);
    console.log(`   ❌ Errors       : ${stats.errors}`);
    console.log(`   💤 Cooldowns    : ${stats.cooldowns}`);
    if (stats.deferred) console.log(`   ⏸  Deferred    : YES (circuit OPEN)`);
    if (stats.quotaExceeded) {
      console.log(`   ⛔ QUOTA_EXCEEDED — checkpoint saved.`);
      console.log(`       Resume at    : ${stats.quotaResetAt ? new Date(stats.quotaResetAt).toISOString() : 'unknown'}`);
      console.log(`       Resume from  : index=${stats.currentIndex}`);
    }
    console.log('='.repeat(60));

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n📦 Disconnected from MongoDB');
  }
}

// Run
batchUpdateTrailers();