/**
 * Migration Script - Cập nhật dữ liệu cũ sang schema mới
 * 
 * Chuyển movies từ embedded categories/countries sang normalized relationships
 * 
 * Cách chạy:
 *   node scripts/migrate-to-normalized-schema.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const { Movie, Category, Country, MovieCategory, MovieCountry } = require('../src/models');
const logger = require('../src/utils/logger');

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: process.env.MONGODB_NAME || 'movie-api',
    });
    logger.info('✅ Connected to MongoDB');

    // Lấy tất cả movies có embedded categories/countries
    const movies = await Movie.find({
      $or: [
        { category: { $exists: true, $ne: [] } },
        { country: { $exists: true, $ne: [] } },
      ]
    }).lean();

    logger.info(`Found ${movies.length} movies with embedded data`);

    let migrated = 0;
    let failed = 0;

    for (const movie of movies) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Migrate categories
        if (Array.isArray(movie.category) && movie.category.length > 0) {
          const categoryIds = [];
          
          for (const cat of movie.category) {
            if (!cat.name) continue;
            
            const slug = cat.slug || generateSlug(cat.name);
            const category = await Category.findOneAndUpdate(
              { slug },
              { name: cat.name, slug },
              { upsert: true, new: true, session }
            );
            
            categoryIds.push(category._id);
          }

          // Clear existing relationships
          await MovieCategory.deleteMany({ movieId: movie._id }, { session });
          
          // Create new relationships
          if (categoryIds.length > 0) {
            const items = categoryIds.map(categoryId => ({
              movieId: movie._id,
              categoryId
            }));
            await MovieCategory.insertMany(items, { session });
          }

          logger.info(`✓ Migrated ${categoryIds.length} categories for: ${movie.name}`);
        }

        // Migrate countries
        if (Array.isArray(movie.country) && movie.country.length > 0) {
          const countryIds = [];
          
          for (const ctr of movie.country) {
            if (!ctr.name) continue;
            
            const slug = ctr.slug || generateSlug(ctr.name);
            const country = await Country.findOneAndUpdate(
              { slug },
              { name: ctr.name, slug },
              { upsert: true, new: true, session }
            );
            
            countryIds.push(country._id);
          }

          // Clear existing relationships
          await MovieCountry.deleteMany({ movieId: movie._id }, { session });
          
          // Create new relationships
          if (countryIds.length > 0) {
            const items = countryIds.map(countryId => ({
              movieId: movie._id,
              countryId
            }));
            await MovieCountry.insertMany(items, { session });
          }

          logger.info(`✓ Migrated ${countryIds.length} countries for: ${movie.name}`);
        }

        // Remove embedded fields (optional - comment out nếu muốn giữ)
        // await Movie.updateOne(
        //   { _id: movie._id },
        //   { $unset: { category: '', country: '' } },
        //   { session }
        // );

        await session.commitTransaction();
        migrated++;

      } catch (error) {
        await session.abortTransaction();
        logger.error(`✗ Failed to migrate ${movie.name}: ${error.message}`);
        failed++;
      } finally {
        session.endSession();
      }
    }

    logger.info('\n========================================');
    logger.info('Migration completed!');
    logger.info(`✅ Migrated: ${migrated}`);
    logger.info(`❌ Failed: ${failed}`);
    logger.info('========================================');

    // Show statistics
    const stats = await getStatistics();
    logger.info('\nDatabase Statistics:');
    logger.info(`- Total Movies: ${stats.totalMovies}`);
    logger.info(`- Total Categories: ${stats.totalCategories}`);
    logger.info(`- Total Countries: ${stats.totalCountries}`);
    logger.info(`- Movie-Category Relations: ${stats.movieCategoryCount}`);
    logger.info(`- Movie-Country Relations: ${stats.movieCountryCount}`);

  } catch (error) {
    logger.error(`Migration error: ${error.message}`);
    throw error;
  } finally {
    await mongoose.disconnect();
    logger.info('\n✅ Disconnected from MongoDB');
  }
}

async function getStatistics() {
  const [
    totalMovies,
    totalCategories,
    totalCountries,
    movieCategoryCount,
    movieCountryCount
  ] = await Promise.all([
    Movie.countDocuments(),
    Category.countDocuments(),
    Country.countDocuments(),
    MovieCategory.countDocuments(),
    MovieCountry.countDocuments(),
  ]);

  return {
    totalMovies,
    totalCategories,
    totalCountries,
    movieCategoryCount,
    movieCountryCount,
  };
}

function generateSlug(text) {
  if (!text) return '';
  
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 100);
}

// Run migration
migrate().catch(error => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
