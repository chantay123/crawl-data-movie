/**
 * Simple test - không dùng utils, connect trực tiếp
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function test() {
  console.log('🧪 Simple Connection Test\n');

  const uri = process.env.MONGODB_URI;
  console.log(`URI: ${uri}`);
  console.log(`DB Name: ${process.env.MONGODB_NAME}\n`);

  try {
    console.log('Connecting...');
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      bufferCommands: false,
    });

    console.log('✅ Connected!\n');

    // Load model trực tiếp
    const Movie = require('../../backend/src/models/Movie');
    
    console.log('Testing query...');
    const count = await Movie.countDocuments();
    console.log(`✅ Found ${count} movies\n`);

    if (count > 0) {
      const sample = await Movie.findOne().lean();
      console.log('Sample movie:');
      console.log(`  Name: ${sample.name}`);
      console.log(`  Slug: ${sample.slug}`);
      console.log(`  TMDB: ${JSON.stringify(sample.tmdb, null, 2)}`);
    }

    console.log('\n✨ Success!\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\nStack:', error.stack);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

test();
