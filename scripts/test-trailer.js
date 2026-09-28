/**
 * Test TMDB Trailer Enrichment
 * Kiểm tra xem trailer có được lưu vào database không
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TMDBService = require('../src/services/TMDBService');
const MovieService = require('../src/services/MovieService');
const { Movie } = require('../src/models');
const logger = require('../src/utils/logger');

async function testTrailer() {
  try {
    // 1. Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // 2. Test TMDB enrichment
    console.log('🎬 Testing TMDB Enrichment...');
    console.log('================================\n');

    const testMovie = {
      name: 'Avengers: Endgame',
      slug: 'avengers-endgame-test',
      year: 2019,
      type: 'single',
      content: 'Test movie',
      origin_name: 'Avengers: Endgame',
    };

    // Enrich with TMDB
    const enriched = await TMDBService.enrichMovieData(testMovie);

    console.log('📋 Enriched Data:');
    console.log('  - TMDB ID:', enriched.tmdbId);
    console.log('  - Trailer URL:', enriched.trailerUrl);
    console.log('  - Poster URL:', enriched.posterUrl?.substring(0, 60) + '...');
    console.log('  - Backdrop URL:', enriched.backdropUrl?.substring(0, 60) + '...');
    console.log('  - Actors:', enriched.actor?.slice(0, 3).join(', '));
    console.log('  - Director:', enriched.director?.join(', '));
    console.log('  - TMDB Videos:', enriched._tmdbData?.videos?.length || 0);
    console.log('');

    // 3. Save to database
    console.log('💾 Saving to database...');
    const result = await MovieService.saveMovie(enriched, 'test', false); // false = skip re-enrichment

    console.log('✅ Saved:', result.movie.name);
    console.log('');

    // 4. Check database
    console.log('🔍 Checking database...');
    const saved = await Movie.findOne({ slug: 'avengers-endgame-test' }).lean();
    
    console.log('📦 Database Record:');
    console.log('  - Name:', saved.name);
    console.log('  - TMDB ID:', saved.tmdbId);
    console.log('  - Trailer URL:', saved.trailerUrl || '❌ EMPTY');
    console.log('  - Poster URL:', saved.posterUrl?.substring(0, 60) + '...');
    console.log('  - Backdrop URL:', saved.backdropUrl?.substring(0, 60) + '...');
    console.log('  - Actors:', saved.actor?.slice(0, 3).join(', '));
    console.log('  - Director:', saved.director?.join(', '));
    console.log('');

    // 5. Check all movies with trailers
    console.log('📊 Statistics:');
    const totalMovies = await Movie.countDocuments();
    const moviesWithTrailer = await Movie.countDocuments({ 
      trailerUrl: { $exists: true, $ne: '' } 
    });
    const moviesWithTMDB = await Movie.countDocuments({ 
      tmdbId: { $exists: true, $ne: null } 
    });

    console.log(`  - Total movies: ${totalMovies}`);
    console.log(`  - Movies with TMDB ID: ${moviesWithTMDB}`);
    console.log(`  - Movies with trailer: ${moviesWithTrailer}`);
    console.log('');

    // 6. Show sample movies with trailers
    if (moviesWithTrailer > 0) {
      console.log('🎥 Sample movies with trailers:');
      const samples = await Movie.find({ 
        trailerUrl: { $exists: true, $ne: '' } 
      })
      .select('name trailerUrl')
      .limit(5)
      .lean();

      samples.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.name}`);
        console.log(`     ${m.trailerUrl}`);
      });
    }

    console.log('\n✅ Test completed!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
  }
}

testTrailer();
