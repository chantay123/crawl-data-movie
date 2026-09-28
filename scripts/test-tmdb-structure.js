/**
 * Test TMDB Structure After Migration
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function test() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const db = mongoose.connection.db;
    const collection = db.collection('movies');

    // Test 1: Check structure
    console.log('🔍 Test 1: Verify TMDB nested structure');
    console.log('==========================================\n');

    const movie = await collection.findOne({ 
      'tmdb.id': { $exists: true, $ne: '' } 
    });

    if (movie) {
      console.log('✅ Found movie with TMDB data:\n');
      console.log('Movie:', movie.name);
      console.log('Slug:', movie.slug);
      console.log('');
      console.log('TMDB Object:');
      console.log(JSON.stringify(movie.tmdb, null, 2));
      console.log('');
      console.log('IMDB Object:');
      console.log(JSON.stringify(movie.imdb, null, 2));
      console.log('');
    } else {
      console.log('❌ No movies with TMDB data found\n');
    }

    // Test 2: Statistics
    console.log('📊 Test 2: Statistics');
    console.log('=====================\n');

    const total = await collection.countDocuments();
    const withTMDB = await collection.countDocuments({ 
      'tmdb.id': { $ne: '' } 
    });
    const withTrailer = await collection.countDocuments({ 
      'tmdb.trailer_url': { $ne: '' } 
    });
    const oldStructure = await collection.countDocuments({
      $or: [
        { tmdbId: { $exists: true } },
        { trailerUrl: { $exists: true } }
      ]
    });

    console.log(`Total movies: ${total}`);
    console.log(`With TMDB ID: ${withTMDB}`);
    console.log(`With trailer: ${withTrailer}`);
    console.log(`Old structure remaining: ${oldStructure}`);
    console.log('');

    // Test 3: Sample movies with trailers
    if (withTrailer > 0) {
      console.log('🎬 Test 3: Movies with trailers');
      console.log('================================\n');

      const samples = await collection.find({ 
        'tmdb.trailer_url': { $ne: '' } 
      })
      .limit(5)
      .toArray();

      samples.forEach((m, i) => {
        console.log(`${i + 1}. ${m.name}`);
        console.log(`   TMDB ID: ${m.tmdb.id}`);
        console.log(`   Trailer: ${m.tmdb.trailer_url}`);
        console.log(`   Rating: ${m.tmdb.vote_average}/10 (${m.tmdb.vote_count} votes)`);
        console.log('');
      });
    }

    console.log('✅ All tests completed!');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

test();
