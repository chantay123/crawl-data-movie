/**
 * Test YouTube Trailer Enrichment
 * Kiểm tra xem trailer (YouTube) có được lưu vào database không.
 *
 * ⭐ Trailer giờ CHỈ lấy từ YouTube Data API v3 (yêu cầu #1).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const MovieService = require('../src/services/MovieService');
const YouTubeService = require('../src/services/YouTubeService');
const { Movie } = require('../src/models');
const logger = require('../src/utils/logger');

async function testTrailer() {
  try {
    // 1. Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // 2. Test YouTube trailer search
    console.log('🎬 Testing YouTube Trailer Enrichment...');
    console.log('================================\n');

    const testMovie = {
      name: 'Avengers: Endgame',
      slug: 'avengers-endgame-test',
      year: 2019,
      type: 'single',
      content: 'Test movie',
      origin_name: 'Avengers: Endgame',
    };

    // Search YouTube cho trailer (NGUỒN DUY NHẤT)
    const trailer = await YouTubeService.searchTrailer(
      testMovie.name,
      testMovie.year,
      testMovie.origin_name
    );

    console.log('📋 Trailer từ YouTube:');
    if (trailer && trailer.key) {
      console.log(`  - Name: ${trailer.name}`);
      console.log(`  - Key: ${trailer.key}`);
      console.log(`  - Type: ${trailer.type}`);
      console.log(`  - Official: ${trailer.official}`);
      console.log(`  - URL: ${trailer.url}`);
    } else {
      console.log('  - Không tìm thấy trailer (NOT_FOUND — không phải lỗi)');
    }
    console.log('');

    // 3. Save to database (skip TMDB enrichment để chỉ test trailer)
    console.log('💾 Saving to database...');
    const result = await MovieService.saveMovie(testMovie, 'test', false);

    console.log('✅ Saved:', result.movie.name);
    console.log('');

    // 4. Check database
    console.log('🔍 Checking database...');
    const saved = await Movie.findOne({ slug: 'avengers-endgame-test' }).lean();

    console.log('📦 Database Record:');
    console.log('  - Name:', saved.name);
    console.log('  - Trailer.key:', saved.trailer?.key || '❌ EMPTY');
    console.log('  - Trailer.url:', saved.trailer?.url || '❌ EMPTY');
    console.log('  - Trailer.type:', saved.trailer?.type);
    console.log('  - Trailer.official:', saved.trailer?.official);
    console.log('  - trailerJobStatus:', saved.trailerJobStatus);
    console.log('');

    // 5. Check all movies with trailers
    console.log('📊 Statistics:');
    const totalMovies = await Movie.countDocuments();
    const moviesWithTrailer = await Movie.countDocuments({
      'trailer.key': { $exists: true, $ne: '' }
    });
    const moviesRATE_LIMITED = await Movie.countDocuments({
      trailerJobStatus: 'RATE_LIMITED'
    });

    console.log(`  - Total movies: ${totalMovies}`);
    console.log(`  - Movies with trailer: ${moviesWithTrailer}`);
    console.log(`  - Movies RATE_LIMITED: ${moviesRATE_LIMITED}`);
    console.log('');

    console.log('='.repeat(60));
    if (saved.trailer?.key) {
      console.log('✅ TRAILER TEST PASSED — YouTube trailer đã lưu vào Movie');
    } else {
      console.log('⚠️  No trailer saved (có thể YouTube bị rate-limit hoặc không tìm thấy)');
    }
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
    await mongoose.disconnect();
  }
}

testTrailer();
