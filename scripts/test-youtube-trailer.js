/**
 * Test YouTube Trailer Service
 * Kiểm tra xem YouTube API có lấy được trailer không
 */

require('dotenv').config();
const YouTubeService = require('../src/services/YouTubeService');

async function testYouTube() {
  console.log('🎬 YouTube Trailer Service Test\n');

  // 1. Check configuration
  console.log('📦 YouTube Configuration:');
  console.log(`   Enabled: ${YouTubeService.enabled}`);
  console.log(`   API Key: ${YouTubeService.apiKey ? '✅ Set' : '❌ Missing'}`);
  console.log('');

  if (!YouTubeService.enabled || !YouTubeService.apiKey) {
    console.log('❌ YouTube not configured properly');
    console.log('   Add YOUTUBE_API_KEY to .env file');
    console.log('   Set ENABLE_YOUTUBE_TRAILER=true');
    return;
  }

  try {
    // 2. Test search trailer
    console.log('📦 Searching for trailer: Avengers Endgame');
    const trailer = await YouTubeService.searchTrailer('Avengers Endgame', 2019);
    
    if (!trailer) {
      console.log('❌ No trailer found');
      return;
    }
    
    console.log('✅ Trailer found:');
    console.log(`   Title: ${trailer.name}`);
    console.log(`   Video ID: ${trailer.key}`);
    console.log(`   Channel: ${trailer.channelTitle}`);
    console.log(`   URL: ${trailer.url}`);
    console.log(`   Published: ${trailer.publishedAt}`);
    console.log('');

    // 3. Test another movie
    console.log('📦 Searching for trailer: Inception');
    const trailer2 = await YouTubeService.searchTrailer('Inception', 2010);
    
    if (trailer2) {
      console.log('✅ Trailer found:');
      console.log(`   Title: ${trailer2.name}`);
      console.log(`   URL: ${trailer2.url}`);
    } else {
      console.log('❌ No trailer found');
    }
    console.log('');

    console.log('='.repeat(60));
    console.log('✅ YOUTUBE TEST PASSED!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    
    if (error.response?.status === 403) {
      console.error('\n🔧 Invalid YouTube API key or quota exceeded');
      console.error('   Get a new key from: https://console.cloud.google.com/');
    } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      console.error('\n🔧 Network error');
      console.error('   Check your internet connection');
    }
  }
}

testYouTube();
