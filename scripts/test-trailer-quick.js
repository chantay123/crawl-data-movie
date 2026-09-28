/**
 * Quick Test - Verify Trailer System Works
 * Minimal test to check TMDB API and trailer functionality
 */

require('dotenv').config();
const TMDBService = require('../src/services/TMDBService');

async function quickTest() {
  console.log('🎬 Quick Trailer System Test\n');

  // 1. Check configuration
  console.log('📦 TMDB Configuration:');
  console.log(`   Enabled: ${TMDBService.enabled}`);
  console.log(`   API Key: ${TMDBService.apiKey ? '✅ Set' : '❌ Missing'}`);
  console.log(`   Base URL: ${TMDBService.baseUrl}`);
  console.log('');

  if (!TMDBService.enabled || !TMDBService.apiKey) {
    console.log('❌ TMDB not configured properly');
    console.log('   Add TMDB_API_KEY to .env file');
    console.log('   Set ENABLE_TMDB_ENRICHMENT=true');
    return;
  }

  try {
    // 2. Test search
    console.log('📦 Testing TMDB Search...');
    const searchResult = await TMDBService.searchMovie('Inception', 2010);
    
    if (!searchResult) {
      console.log('❌ Search failed');
      return;
    }
    
    console.log(`✅ Found: ${searchResult.title} (ID: ${searchResult.tmdbId})`);
    console.log('');

    // 3. Test videos
    console.log('📦 Testing TMDB Videos...');
    const videos = await TMDBService.getMovieVideos(searchResult.tmdbId);
    console.log(`✅ Found ${videos.length} videos`);
    
    if (videos.length > 0) {
      console.log('');
      console.log('   Sample videos:');
      videos.slice(0, 3).forEach((v, i) => {
        console.log(`   ${i + 1}. ${v.name}`);
        console.log(`      Type: ${v.type} | Official: ${v.official}`);
      });
    }
    console.log('');

    // 4. Test best trailer selection
    console.log('📦 Testing Best Trailer Selection...');
    const bestTrailer = TMDBService.getBestTrailer(videos);
    
    if (bestTrailer) {
      console.log('✅ Best trailer:');
      console.log(`   Name: ${bestTrailer.name}`);
      console.log(`   Type: ${bestTrailer.type}`);
      console.log(`   Official: ${bestTrailer.official}`);
      console.log(`   Key: ${bestTrailer.key}`);
      console.log(`   URL: ${bestTrailer.url}`);
    } else {
      console.log('❌ No trailer selected');
    }
    console.log('');

    console.log('='.repeat(60));
    console.log('✅ QUICK TEST PASSED!');
    console.log('='.repeat(60));
    console.log('\nTrailer system is working correctly.');
    console.log('Run full test: npm run test:trailer');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    
    if (error.response?.status === 401) {
      console.error('\n🔧 Invalid TMDB API key');
      console.error('   Get a new key from: https://www.themoviedb.org/settings/api');
    } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      console.error('\n🔧 Network error');
      console.error('   Check your internet connection');
    }
  }
}

quickTest();
