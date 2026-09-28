/**
 * Test Script - Kiểm tra database connection và models
 * 
 * Chạy: node scripts/test-database-connection.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const { connect, getConnectionStatus } = require('../src/utils/db');
const { Movie, Category, Country, MovieCategory, MovieCountry } = require('../src/models');
const logger = require('../src/utils/logger');

async function testConnection() {
  try {
    // 1. Test connection
    logger.info('========================================');
    logger.info('Testing Database Connection...');
    logger.info('========================================\n');

    await connect();

    const status = getConnectionStatus();
    logger.info('Connection Status:');
    logger.info(`- State: ${status.readyStateText}`);
    logger.info(`- Database: ${status.database}`);
    logger.info(`- Host: ${status.host}`);
    logger.info(`- Models Loaded: ${status.modelsCount}`);
    logger.info('');

    // 2. Test models
    logger.info('========================================');
    logger.info('Testing Models...');
    logger.info('========================================\n');

    const models = {
      Movie,
      Category,
      Country,
      MovieCategory,
      MovieCountry,
    };

    for (const [name, Model] of Object.entries(models)) {
      const count = await Model.countDocuments();
      const collection = Model.collection.name;
      logger.info(`✓ ${name}: ${count} documents (collection: ${collection})`);
    }

    // 3. Test indexes
    logger.info('\n========================================');
    logger.info('Testing Indexes...');
    logger.info('========================================\n');

    const movieIndexes = await Movie.collection.getIndexes();
    logger.info('Movie Indexes:');
    Object.keys(movieIndexes).forEach(idx => {
      logger.info(`  - ${idx}`);
    });

    // 4. Sample query test
    logger.info('\n========================================');
    logger.info('Testing Sample Queries...');
    logger.info('========================================\n');

    const sampleMovie = await Movie.findOne().lean();
    if (sampleMovie) {
      logger.info('✓ Sample Movie Found:');
      logger.info(`  - Name: ${sampleMovie.name}`);
      logger.info(`  - Slug: ${sampleMovie.slug}`);
      logger.info(`  - Type: ${sampleMovie.type}`);
      logger.info(`  - Year: ${sampleMovie.year}`);

      // Test relationships
      const categories = await MovieCategory.getCategoriesForMovie(sampleMovie._id);
      const countries = await MovieCountry.getCountriesForMovie(sampleMovie._id);

      logger.info(`  - Categories: ${categories.length}`);
      if (categories.length > 0) {
        categories.forEach(cat => {
          logger.info(`    * ${cat.name} (${cat.slug})`);
        });
      }

      logger.info(`  - Countries: ${countries.length}`);
      if (countries.length > 0) {
        countries.forEach(ctr => {
          logger.info(`    * ${ctr.name} (${ctr.slug})`);
        });
      }

      logger.info(`  - Episodes: ${sampleMovie.episodes?.length || 0} servers`);
    } else {
      logger.info('⚠ No movies found in database');
    }

    // 5. Statistics
    logger.info('\n========================================');
    logger.info('Database Statistics');
    logger.info('========================================\n');

    const stats = await getStatistics();
    logger.info('Collections:');
    logger.info(`  - Movies: ${stats.totalMovies}`);
    logger.info(`  - Categories: ${stats.totalCategories}`);
    logger.info(`  - Countries: ${stats.totalCountries}`);
    logger.info(`  - Formats: ${stats.totalFormats}`);
    logger.info('\nRelationships:');
    logger.info(`  - Movie-Category: ${stats.movieCategoryCount}`);
    logger.info(`  - Movie-Country: ${stats.movieCountryCount}`);
    logger.info('\nMovie Types:');
    Object.entries(stats.moviesByType).forEach(([type, count]) => {
      logger.info(`  - ${type}: ${count}`);
    });

    logger.info('\n✅ All tests passed!');

  } catch (error) {
    logger.error(`\n❌ Test failed: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    logger.info('\n✅ Disconnected from MongoDB');
  }
}

async function getStatistics() {
  const Format = require('../src/models').Format;

  const [
    totalMovies,
    totalCategories,
    totalCountries,
    totalFormats,
    movieCategoryCount,
    movieCountryCount,
    moviesByType
  ] = await Promise.all([
    Movie.countDocuments(),
    Category.countDocuments(),
    Country.countDocuments(),
    Format.countDocuments(),
    MovieCategory.countDocuments(),
    MovieCountry.countDocuments(),
    Movie.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 } } }
    ])
  ]);

  const typeStats = {};
  moviesByType.forEach(item => {
    typeStats[item._id || 'unknown'] = item.count;
  });

  return {
    totalMovies,
    totalCategories,
    totalCountries,
    totalFormats,
    movieCategoryCount,
    movieCountryCount,
    moviesByType: typeStats,
  };
}

// Run test
testConnection().catch(error => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
