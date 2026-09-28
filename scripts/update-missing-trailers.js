/**
 * Update trailers for movies that don't have one
 * Uses YouTube fallback when TMDB fails
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TrailerService = require('../src/services/TrailerService');
const { Movie } = require('../src/models');
const config = require('../src/config');
const logger = require('../src/utils/logger');

async function updateMissingTrailers() {
  try {
    // Connect to MongoDB — dùng config để lấy đúng DB (vd: XomPhim)
    await mongoose.connect(config.mongodb.uri, {
      dbName: config.mongodb.name,
      serverSelectionTimeoutMS: 10000,
    });
    logger.info(`[Script] Connected to MongoDB (db=${config.mongodb.name})`);

    // Find movies without trailer
    const moviesWithoutTrailer = await Movie.find({
      $or: [
        { 'trailer.key': { $exists: false } },
        { 'trailer.key': '' },
        { 'trailer.key': null }
      ]
    })
    .sort({ createdAt: -1 }) // Newest first
    .limit(100)
    .lean();

    logger.info(`[Script] Found ${moviesWithoutTrailer.length} movies without trailer`);

    let successCount = 0;
    let failCount = 0;

    for (const movie of moviesWithoutTrailer) {
      try {
        logger.info(`\n[Script] Processing: ${movie.name}`);
        
        // Get full movie document (not lean)
        const fullMovie = await Movie.findById(movie._id);
        
        // Try to get trailer (TMDB first, then YouTube fallback)
        const trailer = await TrailerService.getTrailer(fullMovie);
        
        if (trailer) {
          successCount++;
          logger.info(`[Script] ✅ Found trailer for: ${movie.name}`);
        } else {
          failCount++;
          logger.warn(`[Script] ❌ No trailer found for: ${movie.name}`);
        }

        // Delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        failCount++;
        logger.error(`[Script] Error processing ${movie.name}: ${error.message}`);
      }
    }

    logger.info(`\n[Script] ==========================================`);
    logger.info(`[Script] Update completed!`);
    logger.info(`[Script] Total: ${moviesWithoutTrailer.length}`);
    logger.info(`[Script] Success: ${successCount}`);
    logger.info(`[Script] Failed: ${failCount}`);
    logger.info(`[Script] ==========================================`);

  } catch (error) {
    logger.error(`[Script] Fatal error: ${error.message}`);
  } finally {
    await mongoose.disconnect();
    logger.info('[Script] Disconnected from MongoDB');
  }
}

// Run the script
updateMissingTrailers();
