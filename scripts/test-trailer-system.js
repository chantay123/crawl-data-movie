/**
 * Test YouTube Trailer System
 * Kiểm tra toàn bộ hệ thống trailer: YouTube API, in-memory state, database.
 *
 * ⭐ Trailer giờ CHỈ lấy từ YouTube Data API v3 (yêu cầu #1).
 *    KHÔNG dùng TMDB cho trailer nữa.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const YouTubeService = require('../src/services/YouTubeService');
const TrailerService = require('../src/services/TrailerService');
const MovieService = require('../src/services/MovieService');
const rateLimiter = require('../src/utils/youtubeRateLimiter');
const trailerState = require('../src/utils/trailerState');
const { Movie } = require('../src/models');
const logger = require('../src/utils/logger');

async function testTrailerSystem() {
  try {
    console.log('='.repeat(60));
    console.log('🎬 TRAILER SYSTEM TEST (YouTube-only)');
    console.log('='.repeat(60));
    console.log('');

    // 1. Connect to MongoDB
    console.log('📦 Step 1: Connect to MongoDB');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // 2. Check YouTube configuration
    console.log('📦 Step 2: Check YouTube Configuration');
    console.log(`   YouTube Enabled: ${YouTubeService.enabled}`);
    console.log(`   YouTube API Key: ${YouTubeService.apiKey ? '✅ Set' : '❌ Missing'}`);
    console.log(`   maxResults: ${YouTubeService.maxResults}`);
    console.log(`   maxQueries: ${YouTubeService.maxQueries}`);
    console.log(`   rateLimitMaxRetries: ${YouTubeService.rateLimitMaxRetries}`);
    console.log(`   requestTimeoutMs: ${YouTubeService.requestTimeoutMs}`);
    console.log(`   YouTube isAvailable: ${YouTubeService.isAvailable()}`);
    console.log('');

    if (!YouTubeService.enabled) {
      console.log('❌ YouTube is disabled. Set ENABLE_YOUTUBE_TRAILER=true and add YOUTUBE_API_KEY in .env');
      return;
    }

    // 3. Test YouTube API - Search
    console.log('📦 Step 3: Test YouTube Search API');
    const testTitle = 'Avengers: Endgame';
    const queries = YouTubeService._buildQueries(testTitle, 2019, 'Avengers: Endgame');
    console.log(`✅ Built ${queries.length} queries:`);
    queries.forEach((q, i) => console.log(`   ${i + 1}. "${q}"`));
    console.log('');

    if (process.env.SKIP_YOUTUBE_SEARCH !== 'true') {
      console.log(`📦 Step 4: Test YouTube search (real API call — sẽ tốn quota)`);
      const trailer = await YouTubeService.searchTrailer(testTitle, 2019, 'Avengers: Endgame');

      if (trailer && trailer.key) {
        console.log('✅ Trailer tìm được:');
        console.log(`   Name: ${trailer.name}`);
        console.log(`   Type: ${trailer.type}`);
        console.log(`   Official: ${trailer.official}`);
        console.log(`   Key: ${trailer.key}`);
        console.log(`   URL: ${trailer.url}`);
      } else {
        console.log('⚠️  Không tìm thấy trailer (NOT_FOUND — không phải lỗi)');
      }
      console.log('');
    } else {
      console.log('⏭ SKIP_YOUTUBE_SEARCH=true — bỏ qua search thật');
      console.log('');
    }

    // 5. TrailerService stats
    console.log('📦 Step 5: TrailerService stats');
    const stats = await TrailerService.getStats();
    console.log(`   total: ${stats.total}`);
    console.log(`   withTrailer: ${stats.withTrailer}`);
    console.log(`   withoutTrailer: ${stats.withoutTrailer}`);
    console.log(`   coverage: ${stats.coverage}`);
    console.log(`   rateLimited: ${stats.rateLimited}`);
    console.log(`   notFound: ${stats.notFound}`);
    console.log(`   youtube.enabled: ${stats.youtube.enabled}`);
    console.log(`   youtube.available: ${stats.youtube.available}`);
    console.log(`   youtube.circuitOpen: ${stats.youtube.circuitOpen}`);
    console.log('');

    // 6. Test Rate Limiter state
    console.log('📦 Step 6: YouTube Rate Limiter status');
    const rl = rateLimiter.status();
    console.log(`   concurrency: ${rl.concurrency}`);
    console.log(`   active: ${rl.active}`);
    console.log(`   cbState: ${rl.cbState}`);
    console.log(`   cbCooldownMs: ${rl.cbCooldownMs}ms`);
    console.log(`   globalCooldownUntil: ${rl.globalCooldownUntil || '(none)'}`);
    console.log(`   globalCooldownReason: ${rl.globalCooldownReason || '(none)'}`);
    console.log('');

    // 7. Test save movie (skip TMDB enrichment)
    console.log('📦 Step 7: Test Save Movie (chỉ YouTube trailer)');
    const testMovie = {
      name: 'Avengers: Endgame',
      slug: 'avengers-endgame-test-' + Date.now(),
      year: 2019,
      type: 'single',
      content: 'Test movie for trailer system',
      origin_name: 'Avengers: Endgame',
    };

    const result = await MovieService.saveMovie(testMovie, 'test', false);

    console.log(`✅ Movie saved: ${result.movie.name}`);
    console.log(`   MongoDB ID: ${result.movie._id}`);
    console.log(`   Is New: ${result.isNew}`);
    console.log(`   trailerResult.status: ${result.trailerResult?.status}`);
    console.log(`   trailerResult.source: ${result.trailerResult?.source}`);
    console.log('');

    // 8. Check database
    console.log('📦 Step 8: Check database');
    const saved = await Movie.findOne({ slug: testMovie.slug }).lean();
    if (saved) {
      console.log('✅ Movie trong DB:');
      console.log(`   Name: ${saved.name}`);
      console.log(`   Trailer.key: ${saved.trailer?.key || '❌ EMPTY'}`);
      console.log(`   Trailer.url: ${saved.trailer?.url || '❌ EMPTY'}`);
      console.log(`   Trailer.type: ${saved.trailer?.type}`);
      console.log(`   trailerJobStatus: ${saved.trailerJobStatus}`);
    } else {
      console.log('❌ Movie không tìm thấy trong DB');
    }
    console.log('');

    // Cleanup
    if (saved) {
      await Movie.deleteOne({ _id: saved._id });
      console.log('  (test movie đã cleanup)');
    }

    console.log('='.repeat(60));
    console.log('✅ TRAILER SYSTEM TEST HOÀN TẤT');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (error.code === 'RATE_LIMITED' || error.status === 429) {
      console.error('\n🔧 YouTube rate-limited (429). Chờ cooldown rồi thử lại.');
    } else if (error.code === 'QUOTA_EXCEEDED') {
      console.error('\n🔧 YouTube daily quota exceeded. Reset lúc 00:00 PT.');
    } else if (error.code === 'CIRCUIT_OPEN') {
      console.error('\n🔧 Circuit breaker OPEN. Chờ cooldown rồi thử lại.');
    }
  } finally {
    trailerState.reset();
    await mongoose.disconnect();
  }
}

testTrailerSystem();
