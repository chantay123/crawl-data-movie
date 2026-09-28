/**
 * Save Trailer to Movie
 * Usage: node save-trailer.js
 */

require('../src/config');
const mongoose = require('mongoose');
const Movie = require('../src/models/movie');
const logger = require('../src/utils/logger');

// Trailer data cần lưu
const trailerData = {
  name: "(Official Trailer) THÁM TỬ LỪNG DANH CONAN: VIÊN ĐẠN ĐỎ | KC: 23.04.21",
  key: "Jrt1aUU2_Xs",
  site: "YouTube",
  type: "Trailer",
  official: true,
  publishedAt: new Date('2021-04-07T07:28:44.000+00:00'),
  url: "https://www.youtube.com/watch?v=Jrt1aUU2_Xs"
};

// Slug phim cần cập nhật
const movieSlug = 'tham-tu-lung-danh-conan-vien-dan-do'; // Thay đổi slug phù hợp

async function saveTrailer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info('✅ Connected to MongoDB');

    // Tìm movie theo slug
    let movie = await Movie.findOne({ slug: movieSlug });
    
    // Nếu không tìm thấy, thử tìm theo tên
    if (!movie) {
      movie = await Movie.findOne({ name: /thám tử lừng danh conan viên đạn đỏ/i });
    }

    if (!movie) {
      logger.error(`❌ Không tìm thấy movie với slug: ${movieSlug}`);
      logger.info('💡 Đang tìm tất cả movies có "conan" trong tên...');
      
      const movies = await Movie.find({ 
        name: /conan/i,
        isHidden: false 
      }).select('slug name trailer').limit(10);
      
      if (movies.length > 0) {
        logger.info(`✅ Tìm thấy ${movies.length} movies:`);
        movies.forEach(m => {
          logger.info(`  - ${m.name} (slug: ${m.slug})`);
          if (m.trailer?.key) {
            logger.info(`    Trailer hiện tại: ${m.trailer.key}`);
          }
        });
      } else {
        logger.info('❌ Không tìm thấy movie nào');
      }
      
      process.exit(1);
    }

    logger.info(`✅ Tìm thấy movie: ${movie.name} (slug: ${movie.slug})`);
    logger.info(`   Trailer hiện tại: ${movie.trailer?.key || 'chưa có'}`);

    // Cập nhật trailer
    movie.trailer = trailerData;
    await movie.save();

    logger.info('✅ Đã lưu trailer thành công!');
    logger.info(`   Name: ${movie.trailer.name}`);
    logger.info(`   Key: ${movie.trailer.key}`);
    logger.info(`   URL: ${movie.trailer.url}`);
    logger.info(`   Official: ${movie.trailer.official}`);

    // Cập nhật tmdb.trailer_url
    movie.tmdb = movie.tmdb || {};
    movie.tmdb.trailer_url = trailerData.url;
    await movie.save();

    logger.info('✅ Đã cập nhật tmdb.trailer_url!');

  } catch (error) {
    logger.error(`❌ Lỗi: ${error.message}`);
  } finally {
    await mongoose.disconnect();
    logger.info('👋 Đã ngắt kết nối MongoDB');
    process.exit(0);
  }
}

saveTrailer();
