/**
 * Check movie trailer in database
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function checkMovie() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    
    const Movie = mongoose.model('Movie');
    
    // Find movie by slug
    const movie = await Movie.findOne({ slug: 'sat-nhan-mat-quy' }).lean();
    
    if (!movie) {
      console.log('❌ Movie not found in movies collection');
      console.log('\nChecking raw collection...');
      
      const db = mongoose.connection.db;
      const rawMovie = await db.collection('movies').findOne({ slug: 'sat-nhan-mat-quy' });
      
      if (rawMovie) {
        console.log('\n📦 Raw document found:');
        console.log('  Collection:', 'movies');
        console.log('  Name:', rawMovie.name);
        console.log('  Source:', rawMovie._source || rawMovie.source);
        console.log('  trailerUrl:', rawMovie.trailerUrl || rawMovie.trailer_url || '❌ EMPTY');
        console.log('  tmdbId:', rawMovie.tmdbId || rawMovie.tmdb?.id || '❌ EMPTY');
        console.log('\n⚠️  This is RAW data - need to transform via MovieService');
      }
      
      return;
    }
    
    console.log('✅ Movie found in transformed collection\n');
    console.log('📋 Movie Info:');
    console.log('  Name:', movie.name);
    console.log('  Slug:', movie.slug);
    console.log('  Source:', movie.source);
    console.log('  Year:', movie.year);
    console.log('');
    
    console.log('🎬 Trailer Info:');
    console.log('  trailerUrl:', movie.trailerUrl || '❌ EMPTY');
    console.log('');
    
    console.log('🎭 TMDB Info:');
    console.log('  tmdbId:', movie.tmdbId || '❌ NOT ENRICHED');
    console.log('  tmdbType:', movie.tmdbType || '❌ NOT ENRICHED');
    console.log('  tmdbVoteAverage:', movie.tmdbVoteAverage || 0);
    console.log('');
    
    console.log('🖼️  Images:');
    console.log('  posterUrl:', movie.posterUrl ? '✅ ' + movie.posterUrl.substring(0, 50) + '...' : '❌ EMPTY');
    console.log('  backdropUrl:', movie.backdropUrl ? '✅ ' + movie.backdropUrl.substring(0, 50) + '...' : '❌ EMPTY');
    console.log('');
    
    if (!movie.tmdbId) {
      console.log('⚠️  Movie chưa được enrich với TMDB!');
      console.log('   Chạy lại crawler với ENABLE_TMDB_ENRICHMENT=true');
    }
    
    if (!movie.trailerUrl && movie.tmdbId) {
      console.log('⚠️  Movie có TMDB ID nhưng không có trailer');
      console.log('   => TMDB không có trailer cho phim này');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

checkMovie();
