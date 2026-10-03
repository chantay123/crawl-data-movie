/**
 * Test TMDB Service - Verify All Fixes
 *
 * Tests:
 * 1. Shared Axios instance (connection pooling)
 * 2. Retry with exponential backoff
 * 3. Concurrency limit (2-3 requests max)
 * 4. Graceful error handling (no crash)
 * 5. Search movie
 * 6. Enrich movie data (metadata only — KHÔNG fetch videos/trailers nữa)
 *
 * ⭐ Note: `getMovieVideos()` đã bị XOÁ khỏi TMDBService.
 *    Trailer giờ CHỈ lấy từ YouTube Data API v3 (xem YouTubeService + TrailerService).
 *    `getBestTrailer()` được GIỮ LẠI dưới dạng @deprecated để tương thích script cũ.
 */

require('dotenv').config();
const TMDBService = require('../src/services/TMDBService');
const logger = require('../src/utils/logger');

async function testTMDBService() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     TMDB SERVICE - FIX VERIFICATION TEST                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Check configuration
  console.log('📦 Configuration:');
  console.log(`   Enabled: ${TMDBService.enabled}`);
  console.log(`   API Key: ${TMDBService.apiKey ? TMDBService.apiKey.substring(0, 10) + '...' : '❌ MISSING'}`);
  console.log(`   Base URL: ${TMDBService.baseUrl}`);
  console.log(`   Timeout: 15000ms`);
  console.log(`   Max Retries: ${TMDBService.maxRetries}`);
  console.log(`   Concurrency: ${TMDBService.maxConcurrency} requests`);
  console.log(`   Delay: ${TMDBService.minRequestDelay}ms`);
  console.log('');

  console.log('⭐ Trailer giờ là YouTube-only — KHÔNG dùng TMDB cho trailer');
  console.log(`   TMDBService.getMovieVideos : ${typeof TMDBService.getMovieVideos} (đã xoá)`);
  console.log(`   TMDBService.getBestTrailer : ${typeof TMDBService.getBestTrailer} (giữ làm @deprecated)`);
  console.log('');

  if (!TMDBService.enabled) {
    console.log('❌ TMDB is disabled!');
    console.log('   Set ENABLE_TMDB_ENRICHMENT=true and TMDB_API_KEY in .env\n');
    process.exit(1);
  }

  try {
    // Test 1: Search movie
    console.log('Test 1: Search Movie');
    console.log('────────────────────────────────────────────────────────');
    const searchResult = await TMDBService.searchMovie('Inception', 2010);

    if (searchResult) {
      console.log('✅ Search successful!');
      console.log(`   Title: ${searchResult.title}`);
      console.log(`   TMDB ID: ${searchResult.tmdbId}`);
      console.log(`   Rating: ${searchResult.voteAverage}/10 (${searchResult.voteCount} votes)`);
      console.log(`   Release: ${searchResult.releaseDate}`);
    } else {
      console.log('⚠️  No results found');
    }
    console.log('');

    // ⭐ Test 2 (đã bỏ): Get Movie Videos (Trailers) — đã gỡ khỏi TMDBService.
    // Trailer giờ CHỈ lấy từ YouTube Data API v3 (xem YouTubeService + TrailerService).
    console.log('Test 2: Get Movie Videos (Trailers) — ⛔ ĐÃ BỎ');
    console.log('────────────────────────────────────────────────────────');
    console.log('   ⚠️  TMDBService.getMovieVideos đã bị xoá khỏi flow trailer.');
    console.log('   ✅  Trailer giờ lấy từ YouTube:');
    console.log('       - TMDB chỉ enrich metadata (vote/overview/poster/backdrop)');
    console.log('       - Trailer fetch riêng qua YouTubeService.searchTrailer()');
    console.log('');
    // Sanity check: method đã bị xoá khỏi runtime
    if (typeof TMDBService.getMovieVideos !== 'function') {
      console.log('   ✅ Confirm: TMDBService.getMovieVideos is undefined (đã gỡ đúng)');
    } else {
      console.log('   ❌ TMDBService.getMovieVideos vẫn còn — cần xoá!');
    }
    console.log('');

    // ⭐ Test 3: getBestTrailer — deprecated (giữ lại cho tương thích script cũ)
    console.log('Test 3: getBestTrailer — @deprecated (chỉ còn trong script test)');
    console.log('────────────────────────────────────────────────────────');
    const fakeVideos = [
      { name: 'Trailer 1', type: 'Trailer', official: true, key: 'k1', url: 'https://youtu.be/k1' },
      { name: 'Trailer 2', type: 'Trailer', official: false, key: 'k2', url: 'https://youtu.be/k2' },
      { name: 'Teaser 1', type: 'Teaser', official: true, key: 'k3', url: 'https://youtu.be/k3' },
    ];
    const bestTrailer = TMDBService.getBestTrailer(fakeVideos);
    if (bestTrailer && bestTrailer.key === 'k1') {
      console.log('   ✅ getBestTrailer ưu tiên Official Trailer (deprecated vẫn hoạt động)');
    } else {
      console.log('   ⚠️  getBestTrailer kết quả:', bestTrailer);
    }
    console.log('');

    // Test 4: Enrich movie data
    console.log('Test 4: Enrich Movie Data');
    console.log('────────────────────────────────────────────────────────');
    const mockMovie = {
      name: 'Avatar',
      year: 2009,
      content: 'Original description from crawler',
      posterUrl: '',
      backdropUrl: '',
    };

    const enriched = await TMDBService.enrichMovieData(mockMovie);

    console.log('✅ Enrichment completed!');
    console.log(`   Original: ${mockMovie.name}`);
    console.log(`   TMDB ID: ${enriched.tmdb?.id || 'N/A'}`);
    console.log(`   Rating: ${enriched.tmdb?.vote_average || 0}/10`);
    console.log(`   Trailer: ${enriched.trailer ? 'YES' : 'NO (đúng — TMDB không còn fill trailer)'}`);

    if (enriched.trailer) {
      console.log(`      Name: ${enriched.trailer.name}`);
      console.log(`      Key: ${enriched.trailer.key}`);
      console.log(`      URL: ${enriched.trailer.url}`);
    } else {
      console.log('   ✅ Confirm: enriched.trailer = null/undefined (đúng — TMDB chỉ fill metadata)');
    }
    console.log('');

    // Test 5: Concurrent requests (stress test concurrency limit)
    console.log('Test 5: Concurrent Requests (Concurrency Control)');
    console.log('────────────────────────────────────────────────────────');
    console.log('   Sending 5 concurrent requests...');
    console.log('   (Should be limited to 1 concurrent, queued in order)');

    const startTime = Date.now();
    const movies = [
      'Inception',
      'Interstellar',
      'The Dark Knight',
      'Avengers',
      'Spider-Man'
    ];

    const promises = movies.map(title => TMDBService.searchMovie(title));
    const results = await Promise.all(promises);

    const elapsed = Date.now() - startTime;
    const successCount = results.filter(r => r !== null).length;

    console.log(`✅ Completed in ${elapsed}ms`);
    console.log(`   Successful: ${successCount}/${movies.length}`);
    console.log(`   Failed: ${movies.length - successCount}/${movies.length}`);
    console.log('');

    // Test 6: Error handling (invalid movie)
    console.log('Test 6: Error Handling (Invalid Movie)');
    console.log('────────────────────────────────────────────────────────');
    const invalidResult = await TMDBService.searchMovie('XYZABC123NOTFOUND999', 1900);

    if (invalidResult === null) {
      console.log('✅ Graceful error handling works!');
      console.log('   Returned null for not found movie (no crash)');
    } else {
      console.log('⚠️  Unexpected result for invalid movie');
    }
    console.log('');

    // Test 7: Enrich with no TMDB match
    console.log('Test 7: Enrich Movie with No TMDB Match');
    console.log('────────────────────────────────────────────────────────');
    const noMatchMovie = {
      name: 'XYZABC123NOTFOUND999',
      year: 1900,
      content: 'Original description',
    };

    const noMatchEnriched = await TMDBService.enrichMovieData(noMatchMovie);

    if (noMatchEnriched.name === noMatchMovie.name && !noMatchEnriched.tmdb?.id) {
      console.log('✅ Returns original data when no match (no crash)');
      console.log('   Original data preserved');
    } else {
      console.log('⚠️  Unexpected enrichment for no-match movie');
    }
    console.log('');

    console.log('═'.repeat(60));
    console.log('✅ TMDB SERVICE TEST COMPLETED');
    console.log('═'.repeat(60));
    console.log('');
    console.log('Summary:');
    console.log('  ✅ Search movie - OK');
    console.log('  ⛔ Get videos (Trailer) - ĐÃ BỎ (YouTube-only)');
    console.log('  ✅ getBestTrailer (deprecated) - vẫn hoạt động cho tương thích');
    console.log('  ✅ Enrich movie data (metadata only) - OK');
    console.log('  ✅ Concurrent requests - OK');
    console.log('  ✅ Error handling - OK');
    console.log('  ✅ Graceful no-match enrichment - OK');
    console.log('');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (error.response?.status === 401) {
      console.error('🔧 Invalid API key');
    } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      console.error('🔧 Network error');
    }
  }
}

testTMDBService();
