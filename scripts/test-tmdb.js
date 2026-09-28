/**
 * Test TMDB Integration
 * 
 * Chạy: node scripts/test-tmdb.js
 */

require('dotenv').config();
const TMDBService = require('../src/services/TMDBService');
const logger = require('../src/utils/logger');

async function testTMDB() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     TMDB INTEGRATION TEST                                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Check if TMDB is enabled
  if (!TMDBService.enabled) {
    console.log('❌ TMDB is disabled!\n');
    console.log('To enable:');
    console.log('1. Get API key from: https://www.themoviedb.org/settings/api');
    console.log('2. Add to .env:');
    console.log('   TMDB_API_KEY=your_api_key_here');
    console.log('   ENABLE_TMDB_ENRICHMENT=true\n');
    return;
  }

  console.log('✅ TMDB is enabled\n');

  // Test movies
  const testMovies = [
    { name: 'Venom: Kèo Cuối', year: 2024 },
    { name: 'Avatar 2', year: 2022 },
    { name: 'One Piece Film: Red', year: 2022 },
    { name: 'Deadpool', year: 2016 },
  ];

  console.log('Testing movie search and enrichment...\n');

  for (const movie of testMovies) {
    console.log('─────────────────────────────────────────────────────────');
    console.log(`🎬 Testing: ${movie.name} (${movie.year})`);
    console.log('─────────────────────────────────────────────────────────\n');

    try {
      // Step 1: Search movie
      console.log('1️⃣ Searching on TMDB...');
      const searchResult = await TMDBService.searchMovie(movie.name, movie.year);
      
      if (!searchResult) {
        console.log('   ❌ Not found\n');
        continue;
      }

      console.log(`   ✅ Found: ${searchResult.title}`);
      console.log(`   TMDB ID: ${searchResult.tmdbId}`);
      console.log(`   Rating: ${searchResult.voteAverage}/10 (${searchResult.voteCount} votes)`);
      console.log('');

      // Step 2: Get details
      console.log('2️⃣ Getting movie details...');
      const details = await TMDBService.getMovieDetails(searchResult.tmdbId);
      
      if (!details) {
        console.log('   ❌ Failed to get details\n');
        continue;
      }

      console.log(`   ✅ Got details`);
      console.log(`   Title: ${details.title}`);
      console.log(`   Overview: ${details.overview?.substring(0, 100)}...`);
      console.log(`   Runtime: ${details.runtime} minutes`);
      console.log('');

      // Step 3: Cast
      console.log('3️⃣ Cast (Top 5):');
      details.cast.slice(0, 5).forEach((actor, idx) => {
        console.log(`   ${idx + 1}. ${actor.name} as ${actor.character}`);
      });
      console.log(`   Total cast: ${details.cast.length}`);
      console.log('');

      // Step 4: Crew
      console.log('4️⃣ Directors:');
      const directors = details.crew.filter(c => c.job === 'Director');
      directors.forEach(director => {
        console.log(`   - ${director.name}`);
      });
      console.log('');

      // Step 5: Videos
      console.log('5️⃣ Videos (Trailers):');
      if (details.videos.length > 0) {
        details.videos.slice(0, 3).forEach((video, idx) => {
          console.log(`   ${idx + 1}. ${video.name} (${video.type})`);
          console.log(`      YouTube: https://www.youtube.com/watch?v=${video.key}`);
        });
        console.log(`   Total videos: ${details.videos.length}`);
      } else {
        console.log('   No trailers found');
      }
      console.log('');

      // Step 6: Test enrichment
      console.log('6️⃣ Testing enrichment...');
      const mockMovieData = {
        name: movie.name,
        slug: movie.name.toLowerCase().replace(/\s+/g, '-'),
        year: movie.year,
        content: '',
        actor: [],
        director: [],
        trailerUrl: '',
      };

      const enriched = await TMDBService.enrichMovieData(mockMovieData);
      
      console.log(`   ✅ Enriched successfully`);
      console.log(`   Actors: ${enriched.actor.length}`);
      console.log(`   Directors: ${enriched.director.length}`);
      console.log(`   Trailer: ${enriched.trailerUrl ? 'Yes' : 'No'}`);
      console.log(`   Poster: ${enriched.posterUrl ? 'Yes' : 'No'}`);
      console.log(`   Backdrop: ${enriched.backdropUrl ? 'Yes' : 'No'}`);
      console.log('');

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}\n`);
    }
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                    TEST COMPLETED                          ');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('📝 Summary:');
  console.log('   • TMDB can search movies by title and year');
  console.log('   • Can fetch detailed information (cast, crew, videos)');
  console.log('   • Can enrich crawler data automatically');
  console.log('   • YouTube trailers are available\n');

  console.log('🚀 Next steps:');
  console.log('   • Enable TMDB enrichment in crawler');
  console.log('   • Crawl movies with: npm run crawl:ophim');
  console.log('   • Movies will automatically get actors and trailers\n');
}

testTMDB().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
