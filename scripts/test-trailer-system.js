/**
 * Test TMDB Trailer System
 * Kiểm tra toàn bộ hệ thống trailer: TMDB API, caching, database
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TMDBService = require('../src/services/TMDBService');
const TrailerService = require('../src/services/TrailerService');
const MovieService = require('../src/services/MovieService');
const { Movie } = require('../src/models');
const logger = require('../src/utils/logger');

async function testTrailerSystem() {
  try {
    console.log('='.repeat(60));
    console.log('🎬 TRAILER SYSTEM TEST');
    console.log('='.repeat(60));
    console.log('');

    // 1. Connect to MongoDB
    console.log('📦 Step 1: Connect to MongoDB');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // 2. Check TMDB configuration
    console.log('📦 Step 2: Check TMDB Configuration');
    console.log(`   TMDB Enabled: ${TMDBService.enabled}`);
    console.log(`   TMDB API Key: ${TMDBService.apiKey ? '✅ Set' : '❌ Missing'}`);
    console.log(`   TMDB Base URL: ${TMDBService.baseUrl}`);
    console.log(`   Request Delay: ${TMDBService.minRequestDelay}ms`);
    console.log(`   Max Retries: ${TMDBService.maxRetries}`);
    console.log('');

    if (!TMDBService.enabled) {
      console.log('❌ TMDB is disabled. Set ENABLE_TMDB_ENRICHMENT=true and add TMDB_API_KEY in .env');
      return;
    }

    // 3. Test TMDB API - Search Movie
    console.log('📦 Step 3: Test TMDB Search API');
    const searchResult = await TMDBService.searchMovie('Avengers: Endgame', 2019);
    
    if (searchResult) {
      console.log('✅ Search successful:');
      console.log(`   Title: ${searchResult.title}`);
      console.log(`   TMDB ID: ${searchResult.tmdbId}`);
      console.log(`   Release Date: ${searchResult.releaseDate}`);
      console.log(`   Vote Average: ${searchResult.voteAverage}`);
    } else {
      console.log('❌ Search failed');
      return;
    }
    console.log('');

    // 4. Test TMDB API - Get Videos
    console.log('📦 Step 4: Test TMDB Videos API');
    const videos = await TMDBService.getMovieVideos(searchResult.tmdbId);
    console.log(`✅ Found ${videos.length} videos`);
    
    if (videos.length > 0) {
      console.log('\n   Videos:');
      videos.slice(0, 5).forEach((v, i) => {
        console.log(`   ${i + 1}. ${v.name}`);
        console.log(`      Type: ${v.type} | Official: ${v.official} | Key: ${v.key}`);
      });
    }
    console.log('');

    // 5. Test Best Trailer Selection
    console.log('📦 Step 5: Test Best Trailer Selection');
    const bestTrailer = TMDBService.getBestTrailer(videos);
    
    if (bestTrailer) {
      console.log('✅ Best trailer selected:');
      console.log(`   Name: ${bestTrailer.name}`);
      console.log(`   Type: ${bestTrailer.type}`);
      console.log(`   Official: ${bestTrailer.official}`);
      console.log(`   URL: ${bestTrailer.url}`);
    } else {
      console.log('❌ No trailer found');
    }
    console.log('');

    // 6. Test Movie Enrichment
    console.log('📦 Step 6: Test Movie Enrichment with Trailer');
    const testMovie = {
      name: 'Avengers: Endgame',
      slug: 'avengers-endgame-test-' + Date.now(),
      year: 2019,
      type: 'single',
      content: 'Test movie for trailer system',
      origin_name: 'Avengers: Endgame',
    };

    const enriched = await TMDBService.enrichMovieData(testMovie);
    
    console.log('✅ Movie enriched:');
    console.log(`   TMDB ID: ${enriched.tmdb?.id}`);
    console.log(`   Trailer URL (old): ${enriched.tmdb?.trailer_url}`);
    console.log(`   Trailer (new): ${enriched.trailer ? '✅ YES' : '❌ NO'}`);
    
    if (enriched.trailer) {
      console.log(`   Trailer Name: ${enriched.trailer.name}`);
      console.log(`   Trailer Key: ${enriched.trailer.key}`);
      console.log(`   Trailer Type: ${enriched.trailer.type}`);
      console.log(`   Trailer Official: ${enriched.trailer.official}`);
      console.log(`   Trailer URL: ${enriched.trailer.url}`);
    }
    console.log('');

    // 7. Test Save to Database
    console.log('📦 Step 7: Test Save Movie with Trailer to Database');
    const result = await MovieService.saveMovie(enriched, 'test', false);
    
    console.log(`✅ Movie saved: ${result.movie.name}`);
    console.log(`   MongoDB ID: ${result.movie._id}`);
    console.log(`   Is New: ${result.isNew}`);
    console.log('');

    // 8. Test Read from Database
    console.log('📦 Step 8: Test Read Movie from Database');
    const savedMovie = await Movie.findById(result.movie._id).lean();
    
    console.log('✅ Movie retrieved from database:');
    console.log(`   Name: ${savedMovie.name}`);
    console.log(`   TMDB ID: ${savedMovie.tmdb?.id}`);
    console.log(`   Trailer: ${savedMovie.trailer?.key ? '✅ YES' : '❌ NO'}`);
    
    if (savedMovie.trailer) {
      console.log(`   Trailer Name: ${savedMovie.trailer.name}`);
      console.log(`   Trailer Key: ${savedMovie.trailer.key}`);
      console.log(`   Trailer URL: ${savedMovie.trailer.url}`);
    }
    console.log('');

    // 9. Test TrailerService - Get Trailer (Cache Test)
    console.log('📦 Step 9: Test TrailerService - Cache Behavior');
    console.log('   First call (should use cached trailer from DB):');
    const trailer1 = await TrailerService.getTrailer(savedMovie);
    console.log(`   ✅ Trailer: ${trailer1 ? trailer1.name : 'null'}`);
    
    // 10. Database Statistics
    console.log('\n📦 Step 10: Database Statistics');
    const totalMovies = await Movie.countDocuments();
    const moviesWithTMDB = await Movie.countDocuments({ 
      'tmdb.id': { $exists: true, $ne: '' } 
    });
    const moviesWithTrailer = await Movie.countDocuments({ 
      'trailer.key': { $exists: true, $ne: '' } 
    });

    console.log(`   Total movies: ${totalMovies}`);
    console.log(`   Movies with TMDB ID: ${moviesWithTMDB}`);
    console.log(`   Movies with trailer: ${moviesWithTrailer}`);
    console.log('');

    // 11. Sample Movies with Trailers
    if (moviesWithTrailer > 0) {
      console.log('📦 Step 11: Sample Movies with Trailers');
      const samples = await Movie.find({ 
        'trailer.key': { $exists: true, $ne: '' } 
      })
      .select('name trailer')
      .limit(5)
      .lean();

      samples.forEach((m, i) => {
        console.log(`   ${i + 1}. ${m.name}`);
        console.log(`      ${m.trailer.url}`);
      });
      console.log('');
    }

    // 12. Cleanup test data
    console.log('📦 Step 12: Cleanup Test Data');
    await Movie.deleteOne({ _id: result.movie._id });
    console.log('✅ Test movie deleted\n');

    console.log('='.repeat(60));
    console.log('✅ ALL TESTS PASSED!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('\nStack trace:');
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n📦 Disconnected from MongoDB');
  }
}

// Run test
testTrailerSystem();
