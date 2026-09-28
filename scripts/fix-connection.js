/**
 * Fix MongoDB Connection Timeout
 * Clear cache và test connection
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function fixConnection() {
  console.log('🔧 Fixing MongoDB connection...\n');

  try {
    // 1. Clear all require cache
    console.log('1️⃣ Clearing require cache...');
    Object.keys(require.cache).forEach(key => {
      if (key.includes('models') || key.includes('Movie')) {
        delete require.cache[key];
      }
    });
    console.log('✅ Cache cleared\n');

    // 2. Delete old models
    console.log('2️⃣ Deleting old models...');
    if (mongoose.models.Movie) {
      delete mongoose.models.Movie;
    }
    if (mongoose.modelSchemas && mongoose.modelSchemas.Movie) {
      delete mongoose.modelSchemas.Movie;
    }
    console.log('✅ Old models deleted\n');

    // 3. Connect to MongoDB
    console.log('3️⃣ Connecting to MongoDB...');
    const uri = process.env.MONGODB_URI;
    console.log(`   URI: ${uri}\n`);

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      bufferCommands: false,
      maxPoolSize: 10,
    });

    console.log('✅ Connected successfully\n');

    // 4. Load fresh model
    console.log('4️⃣ Loading fresh Movie model...');
    const Movie = require('../../backend/src/models/Movie');
    console.log('✅ Model loaded\n');

    // 5. Test query
    console.log('5️⃣ Testing query...');
    const count = await Movie.countDocuments();
    console.log(`✅ Query successful! Found ${count} movies\n`);

    // 6. Test sample movie
    console.log('6️⃣ Fetching sample movie...');
    const sample = await Movie.findOne().lean();
    if (sample) {
      console.log('✅ Sample movie:');
      console.log(`   Name: ${sample.name}`);
      console.log(`   Slug: ${sample.slug}`);
      console.log(`   TMDB ID: ${sample.tmdb?.id || 'N/A'}`);
      console.log(`   Trailer: ${sample.tmdb?.trailer_url || 'N/A'}`);
    }

    console.log('\n✨ All checks passed! Connection is working.\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\n💡 Troubleshooting:');
    console.error('   1. Make sure MongoDB is running: mongod');
    console.error('   2. Check MONGODB_URI in .env file');
    console.error('   3. Verify database name is correct');
    console.error('   4. Try restarting MongoDB service\n');
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

fixConnection();
