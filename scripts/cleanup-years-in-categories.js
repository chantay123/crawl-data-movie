/**
 * Cleanup Script - Remove Years from Categories (Simple Version)
 * 
 * Vấn đề: Năm (2023, 2024...) bị lưu nhầm vào bảng categories
 * Nguyên nhân: Nguonc API trả "Năm" trong category object
 * 
 * Script này sẽ:
 * 1. Xóa các năm khỏi bảng categories
 * 2. Xóa các liên kết sai trong movie_categories
 * 
 * NOTE: Phim vẫn có field year trong movies table, không bị mất data
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Category, MovieCategory } = require('../src/models');
const logger = require('../src/utils/logger');
const config = require('../src/config');

async function cleanupYearsInCategories() {
  try {
    await mongoose.connect(config.mongodb.uri);
    logger.info('✅ Connected to MongoDB');

    // 1. Find all year-like categories (2023, 2024, etc.)
    const yearPattern = /^(19|20)\d{2}$/;
    const yearCategories = await Category.find({ 
      name: { $regex: yearPattern } 
    });

    logger.info(`\n📊 Found ${yearCategories.length} year entries in categories table`);
    
    if (yearCategories.length === 0) {
      logger.info('✅ No cleanup needed - categories table is clean!');
      await mongoose.connection.close();
      process.exit(0);
    }

    // Log the years found
    logger.info('\n🔍 Years found in categories:');
    yearCategories.forEach(cat => {
      logger.info(`   - ${cat.name} (${cat.slug}) - ID: ${cat._id}`);
    });

    const yearCategoryIds = yearCategories.map(c => c._id);

    // 2. Count movies linked to these year categories
    const movieYearLinksCount = await MovieCategory.countDocuments({ 
      categoryId: { $in: yearCategoryIds } 
    });

    logger.info(`\n📊 Found ${movieYearLinksCount} movie links to year categories`);

    // 3. Delete year-category links from movie_categories
    logger.info('\n🗑️  Deleting incorrect links from movie_categories...');
    const deletedLinks = await MovieCategory.deleteMany({ 
      categoryId: { $in: yearCategoryIds } 
    });
    logger.info(`   ✅ Deleted ${deletedLinks.deletedCount} links`);

    // 4. Delete year categories from categories table
    logger.info('\n🗑️  Deleting year entries from categories...');
    const deletedCategories = await Category.deleteMany({ 
      name: { $regex: yearPattern } 
    });
    logger.info(`   ✅ Deleted ${deletedCategories.deletedCount} year entries`);

    // 5. Verify cleanup
    const remainingYears = await Category.countDocuments({ 
      name: { $regex: yearPattern } 
    });

    logger.info(`\n✅ Cleanup completed!`);
    logger.info(`   Remaining year entries in categories: ${remainingYears}`);
    
    if (remainingYears === 0) {
      logger.info(`   🎉 Categories table is now clean!`);
    } else {
      logger.warn(`   ⚠️  Warning: ${remainingYears} year entries still remain`);
    }

    // 6. Show current categories (top 10)
    const categories = await Category.find({})
      .sort({ name: 1 })
      .limit(10)
      .lean();
    
    logger.info(`\n📊 Categories in database (sample):`);
    categories.forEach(c => {
      logger.info(`   - ${c.name} (${c.slug})`);
    });

    await mongoose.connection.close();
    logger.info('\n✅ Database connection closed');
    process.exit(0);

  } catch (error) {
    logger.error(`\n❌ Cleanup failed: ${error.message}`);
    logger.error(error.stack);
    
    try {
      await mongoose.connection.close();
    } catch (closeErr) {
      logger.error(`Failed to close connection: ${closeErr.message}`);
    }
    
    process.exit(1);
  }
}

// Run cleanup with confirmation
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\n⚠️  WARNING: This script will DELETE year entries from categories table');
console.log('Examples: "2023", "2024", etc.');
console.log('\nMovies will NOT lose data - they still have the year field in movies table\n');

rl.question('Continue? (yes/no): ', (answer) => {
  rl.close();
  
  if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
    cleanupYearsInCategories();
  } else {
    console.log('❌ Cleanup cancelled');
    process.exit(0);
  }
});
