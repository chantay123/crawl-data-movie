/**
 * Batch Update Trailers
 * Script để cập nhật trailer cho tất cả movies có TMDB ID nhưng chưa có trailer
 *
 * ⭐ BATCH + DELAY + COOLDOWN (yêu cầu #1-#11):
 *   - Sequential, batch size mặc định 10, 60s pause giữa batch,
 *     3-8s delay giữa phim, 30-min cooldown khi gặp 429.
 *
 * Usage:
 *   node scripts/batch-update-trailers.js
 *   node scripts/batch-update-trailers.js 50          (max movies cap, legacy)
 *   node scripts/batch-update-trailers.js 50 20       (max=50, batchSize=20)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TrailerService = require('../src/services/TrailerService');
const logger = require('../src/utils/logger');

function parseArg(name, def) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!arg) return def;
  const v = parseInt(arg.split('=')[1], 10);
  return Number.isFinite(v) ? v : def;
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

    // Get config from CLI (legacy positional args + new --batch-size)
    const positional = process.argv.slice(2).filter(a => /^\d+$/.test(a));
    const limit = positional[0] ? parseInt(positional[0], 10) : 0;
    const batchSize = parseArg('batch-size',
      positional[1] ? parseInt(positional[1], 10) : 10
    );

    console.log(`📦 maxMovies: ${limit || '(default from config)'}`);
    console.log(`📦 batchSize: ${batchSize} (allowed: 10/20/30/40)\n`);

    // Run batch update
    console.log('📦 Starting batch update...\n');
    const stats = await TrailerService.batchUpdateTrailers({
      batchSize,
      limit: limit > 0 ? limit : undefined,
    });

    // Display results
    console.log('\n' + '='.repeat(60));
    console.log('✅ BATCH UPDATE COMPLETED');
    console.log('='.repeat(60));
    console.log(`   Total processed : ${stats.total}`);
    console.log(`   Batches         : ${stats.batches || 0}`);
    console.log(`   ✅ Success      : ${stats.found}`);
    console.log(`   ⛔ Rate limited : ${stats.rateLimited}`);
    console.log(`   ⚠️  Not found   : ${stats.notFound}`);
    console.log(`   ⏭  Skipped     : ${stats.skipped}`);
    console.log(`   ❌ Errors       : ${stats.errors}`);
    console.log(`   💤 Cooldowns    : ${stats.cooldowns}`);
    if (stats.deferred) console.log(`   ⏸  Deferred    : YES (circuit OPEN)`);
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
