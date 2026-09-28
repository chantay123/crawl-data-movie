/**
 * Batch Update Trailers
 * Script để cập nhật trailer cho tất cả movies có TMDB ID nhưng chưa có trailer
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TrailerService = require('../src/services/TrailerService');
const logger = require('../src/utils/logger');

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

    // Get batch size from command line or default 50
    const limit = parseInt(process.argv[2]) || 50;
    console.log(`📦 Batch size: ${limit} movies\n`);

    // Run batch update
    console.log('📦 Starting batch update...\n');
    const stats = await TrailerService.batchUpdateTrailers(limit);

    // Display results
    console.log('\n' + '='.repeat(60));
    console.log('✅ BATCH UPDATE COMPLETED');
    console.log('='.repeat(60));
    console.log(`   Total processed: ${stats.total}`);
    console.log(`   ✅ Success: ${stats.success}`);
    console.log(`   ❌ Failed: ${stats.failed}`);
    console.log(`   ℹ️  No trailer available: ${stats.noTrailer}`);
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
