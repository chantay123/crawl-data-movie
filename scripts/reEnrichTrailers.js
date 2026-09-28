require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const config = require('../src/config');
const TMDBService = require('../src/services/TMDBService');

async function reEnrichTrailers() {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  console.log('🔗 Connected to MongoDB\n');

  const db = mongoose.connection.db;
  
  // Find all movies without trailer OR without tmdb.id
  const movies = await db.collection('movies').find({
    $or: [
      { 'tmdb.id': { $exists: false } },
      { 'tmdb.id': '' },
      { 'tmdb.id': null },
      { trailer: { $exists: false } },
      { trailer: null },
      { 'trailer.key': '' },
      { 'trailer.key': null }
    ]
  }).toArray();

  console.log(`📊 Tìm thấy ${movies.length} movies cần re-enrich\n`);

  let success = 0;
  let failed = 0;

  for (const movie of movies) {
    try {
      console.log(`\n🔍 Đang xử lý: ${movie.name}`);
      console.log(`   originName: ${movie.originName || 'N/A'}`);
      
      // Prepare data for TMDB enrichment
      const movieData = {
        name: movie.name,
        originName: movie.originName || movie.name,
        year: movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : null,
        content: movie.content
      };

      // Enrich with TMDB
      const enriched = await TMDBService.enrichMovieData(movieData);
      
      if (enriched.tmdb?.id) {
        // Update movie with TMDB data
        await db.collection('movies').updateOne(
          { _id: movie._id },
          { 
            $set: {
              'tmdb.id': enriched.tmdb.id,
              'tmdb.vote_average': enriched.tmdb.vote_average,
              'tmdb.vote_count': enriched.tmdb.vote_count,
              'tmdb.trailer_url': enriched.tmdb.trailer_url || '',
              trailer: enriched.trailer || null,
              content: enriched.content || movie.content,
              posterUrl: enriched.posterUrl || movie.posterUrl,
              backdropUrl: enriched.backdropUrl || movie.backdropUrl,
              updatedAt: new Date()
            }
          }
        );
        success++;
        console.log(`   ✅ TMDB ID: ${enriched.tmdb.id}`);
        if (enriched.trailer) {
          console.log(`   🎬 Trailer: ${enriched.trailer.name}`);
        } else {
          console.log(`   ⚠️  Không tìm thấy trailer`);
        }
      } else {
        failed++;
        console.log(`   ❌ Không tìm thấy trên TMDB`);
      }
    } catch (error) {
      failed++;
      console.error(`   ❌ Lỗi: ${error.message}`);
    }

    // Small delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n========================================');
  console.log(`✅ Thành công: ${success}`);
  console.log(`❌ Thất bại: ${failed}`);
  console.log('========================================\n');

  await mongoose.disconnect();
}

reEnrichTrailers().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
