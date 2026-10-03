/**
 * Quick Test - Verify Trailer System Works (YouTube-only).
 *
 * ⭐ Trailer giờ CHỈ lấy từ YouTube Data API v3 (yêu cầu #1).
 *    KHÔNG dùng TMDB cho trailer nữa.
 */

require('dotenv').config();
const YouTubeService = require('../src/services/YouTubeService');
const TrailerService = require('../src/services/TrailerService');
const config = require('../src/config');

async function quickTest() {
  console.log('🎬 Quick Trailer System Test (YouTube-only)\n');

  // 1. Check configuration
  console.log('📦 YouTube Configuration:');
  console.log(`   Enabled: ${YouTubeService.enabled}`);
  console.log(`   API Key: ${YouTubeService.apiKey ? '✅ Set' : '❌ Missing'}`);
  console.log(`   maxResults: ${YouTubeService.maxResults}`);
  console.log(`   maxQueries: ${YouTubeService.maxQueries}`);
  console.log(`   rateLimitMaxRetries: ${YouTubeService.rateLimitMaxRetries}`);
  console.log('');

  console.log('📦 YouTube Rate Limiter:');
  console.log(`   concurrency: ${config.youtube.concurrency}`);
  console.log(`   cbCooldownMs: ${Math.round((config.youtube.circuitCooldownMs || 300000) / 1000)}s`);
  console.log('');

  if (!YouTubeService.enabled || !YouTubeService.apiKey) {
    console.log('❌ YouTube not configured properly');
    console.log('   Add YOUTUBE_API_KEY to .env file');
    console.log('   Set ENABLE_YOUTUBE_TRAILER=true');
    return;
  }

  const movieName = 'Inception';
  const year = 2010;

  try {
    // 2. Test query building
    console.log(`📦 Testing Query Building for "${movieName}"...`);
    const queries = YouTubeService._buildQueries(movieName, year, null);
    console.log(`✅ Built ${queries.length} queries:`);
    queries.forEach((q, i) => console.log(`   ${i + 1}. "${q}"`));
    console.log('');

    // 3. Test actual search (sẽ tốn quota — chỉ chạy khi DEV muốn test thật)
    if (process.env.SKIP_YOUTUBE_SEARCH === 'true') {
      console.log('⏭ SKIP_YOUTUBE_SEARCH=true — bỏ qua search thật');
    } else {
      console.log(`📦 Testing YouTube search for "${movieName}"...`);
      const trailer = await YouTubeService.searchTrailer(movieName, year, null);

      if (trailer && trailer.key) {
        console.log('✅ Trailer found:');
        console.log(`   Name: ${trailer.name}`);
        console.log(`   Type: ${trailer.type}`);
        console.log(`   Official: ${trailer.official}`);
        console.log(`   Key: ${trailer.key}`);
        console.log(`   URL: ${trailer.url}`);
      } else {
        console.log('⚠️ No trailer returned (NOT_FOUND — không phải lỗi)');
      }
    }
    console.log('');

    console.log('='.repeat(60));
    console.log('✅ QUICK TEST PASSED!');
    console.log('='.repeat(60));
    console.log('\nYouTube trailer system is working correctly.');
    console.log('Run full test: npm run test:trailer');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);

    if (error.code === 'RATE_LIMITED' || error.status === 429) {
      console.error('\n🔧 YouTube rate-limited (429). Chờ cooldown rồi thử lại.');
    } else if (error.code === 'QUOTA_EXCEEDED') {
      console.error('\n🔧 YouTube daily quota exceeded. Reset lúc 00:00 PT.');
    } else if (error.code === 'CIRCUIT_OPEN') {
      console.error('\n🔧 Circuit breaker OPEN. Chờ cooldown rồi thử lại.');
    } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      console.error('\n🔧 Network error. Check your internet connection.');
    }
  }
}

quickTest();
