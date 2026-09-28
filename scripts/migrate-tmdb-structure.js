/**
 * Migration Script: Restructure TMDB data to nested object
 * 
 * Changes:
 * - Move tmdbId, tmdbType, tmdbSeason, tmdbVoteAverage, tmdbVoteCount -> tmdb object
 * - Move trailerUrl -> tmdb.trailer_url
 * - Move imdbId -> imdb.id
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function migrate() {
  try {
    console.log('🔄 Starting TMDB structure migration...\n');
    
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const db = mongoose.connection.db;
    const collection = db.collection('movies');

    // Get all movies
    const movies = await collection.find({}).toArray();
    console.log(`📊 Found ${movies.length} movies\n`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const movie of movies) {
      try {
        const updateData = {};
        let needsUpdate = false;

        // Build tmdb object
        const tmdb = {
          type: movie.tmdbType || movie.tmdb?.type || null,
          id: movie.tmdbId || movie.tmdb?.id || '',
          season: movie.tmdbSeason || movie.tmdb?.season || null,
          vote_average: movie.tmdbVoteAverage || movie.tmdb?.vote_average || 0,
          vote_count: movie.tmdbVoteCount || movie.tmdb?.vote_count || 0,
          trailer_url: movie.trailerUrl || movie.tmdb?.trailer_url || ''
        };

        // Build imdb object
        const imdb = {
          id: movie.imdbId || movie.imdb?.id || ''
        };

        // Check if we need to update
        if (movie.tmdbId || movie.tmdbType || movie.tmdbSeason || 
            movie.tmdbVoteAverage || movie.tmdbVoteCount || 
            movie.trailerUrl || movie.imdbId) {
          needsUpdate = true;
        }

        if (!needsUpdate) {
          skipped++;
          continue;
        }

        // Set new structure
        updateData.$set = {
          tmdb: tmdb,
          imdb: imdb
        };

        // Unset old fields
        updateData.$unset = {
          tmdbType: '',
          tmdbId: '',
          tmdbSeason: '',
          tmdbVoteAverage: '',
          tmdbVoteCount: '',
          trailerUrl: '',
          imdbId: ''
        };

        await collection.updateOne(
          { _id: movie._id },
          updateData
        );

        updated++;
        
        if (updated % 100 === 0) {
          console.log(`  Processed ${updated} movies...`);
        }

      } catch (error) {
        console.error(`  ❌ Error updating ${movie.name}: ${error.message}`);
        errors++;
      }
    }

    console.log('\n✅ Migration completed!');
    console.log(`  Updated: ${updated}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Errors: ${errors}`);
    console.log('');

    // Show sample of migrated data
    console.log('📋 Sample migrated movie:');
    const sample = await collection.findOne({ 'tmdb.id': { $ne: '' } });
    if (sample) {
      console.log('  Name:', sample.name);
      console.log('  TMDB:', JSON.stringify(sample.tmdb, null, 2));
      console.log('  IMDB:', JSON.stringify(sample.imdb, null, 2));
    }

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
  }
}

migrate();
