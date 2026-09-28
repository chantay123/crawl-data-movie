#!/usr/bin/env node

/**
 * Quick Start Script - Test toàn bộ hệ thống
 * 
 * Script này sẽ:
 * 1. Test database connection
 * 2. Crawl 1 trang từ OPhim
 * 3. Verify data đã lưu đúng với relationships
 * 4. Show statistics
 */

const mongoose = require('mongoose');
require('dotenv').config();

const { connect, disconnect, getConnectionStatus } = require('../src/utils/db');
const { Movie, Category, Country, MovieCategory, MovieCountry } = require('../src/models');
const OPhimSource = require('../src/sources/OPhimSource');
const CrawlerService = require('../src/services/CrawlerService');
const logger = require('../src/utils/logger');
const config = require('../src/config');

async function quickStart() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     MOVIE CRAWLER - QUICK START & VERIFICATION           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // ============================================================
    // STEP 1: Test Database Connection
    // ============================================================
    console.log('📊 STEP 1: Testing Database Connection...\n');
    
    await connect();
    const status = getConnectionStatus();
    
    console.log('✅ Connection successful!');
    console.log(`   Database: ${status.database}`);
    console.log(`   Host: ${status.host}`);
    console.log(`   Models: ${status.modelsCount} loaded`);
    console.log('');

    // ============================================================
    // STEP 2: Show Current Statistics
    // ============================================================
    console.log('📈 STEP 2: Current Database Statistics...\n');
    
    const beforeStats = await getStats();
    console.log(`   Movies: ${beforeStats.movies}`);
    console.log(`   Categories: ${beforeStats.categories}`);
    console.log(`   Countries: ${beforeStats.countries}`);
    console.log(`   Movie-Category Relations: ${beforeStats.movieCategories}`);
    console.log(`   Movie-Country Relations: ${beforeStats.movieCountries}`);
    console.log('');

    // ============================================================
    // STEP 3: Crawl Sample Page
    // ============================================================
    console.log('🕷️  STEP 3: Crawling 1 page from OPhim...\n');
    
    const source = new OPhimSource({ baseUrl: config.sources.ophim.baseUrl });
    const crawler = new CrawlerService(source, {
      detailConcurrency: 5,
      pageDelayMs: 1000,
      useMongo: true,
    });

    const result = await crawler.crawlPage(1);
    
    console.log('✅ Crawl completed!');
    console.log(`   Items found: ${result.itemsFound}`);
    console.log(`   New movies saved: ${result.savedMovies.length}`);
    console.log(`   Existing movies updated: ${result.updatedMovies.length}`);
    console.log('');

    // ============================================================
    // STEP 4: Verify Data & Relationships
    // ============================================================
    console.log('🔍 STEP 4: Verifying Data & Relationships...\n');
    
    const afterStats = await getStats();
    const delta = {
      movies: afterStats.movies - beforeStats.movies,
      categories: afterStats.categories - beforeStats.categories,
      countries: afterStats.countries - beforeStats.countries,
      movieCategories: afterStats.movieCategories - beforeStats.movieCategories,
      movieCountries: afterStats.movieCountries - beforeStats.movieCountries,
    };

    console.log('📊 Changes:');
    console.log(`   Movies: +${delta.movies}`);
    console.log(`   Categories: +${delta.categories}`);
    console.log(`   Countries: +${delta.countries}`);
    console.log(`   Movie-Category Relations: +${delta.movieCategories}`);
    console.log(`   Movie-Country Relations: +${delta.movieCountries}`);
    console.log('');

    // ============================================================
    // STEP 5: Sample Data Inspection
    // ============================================================
    console.log('🔬 STEP 5: Inspecting Sample Data...\n');
    
    const sampleMovie = await Movie.findOne().sort({ createdAt: -1 }).lean();
    
    if (sampleMovie) {
      console.log('📽️  Latest Movie:');
      console.log(`   Name: ${sampleMovie.name}`);
      console.log(`   Slug: ${sampleMovie.slug}`);
      console.log(`   Type: ${sampleMovie.type}`);
      console.log(`   Year: ${sampleMovie.year}`);
      console.log(`   Source: ${sampleMovie.source}`);
      console.log(`   Quality: ${sampleMovie.quality}`);
      
      // Get relationships
      const categories = await MovieCategory.getCategoriesForMovie(sampleMovie._id);
      const countries = await MovieCountry.getCountriesForMovie(sampleMovie._id);
      
      console.log(`\n   📁 Categories (${categories.length}):`);
      categories.forEach(cat => {
        console.log(`      - ${cat.name} (${cat.slug})`);
      });
      
      console.log(`\n   🌍 Countries (${countries.length}):`);
      countries.forEach(ctr => {
        console.log(`      - ${ctr.name} (${ctr.slug})`);
      });
      
      console.log(`\n   🎬 Episodes: ${sampleMovie.episodes?.length || 0} servers`);
      if (sampleMovie.episodes && sampleMovie.episodes.length > 0) {
        sampleMovie.episodes.forEach(server => {
          console.log(`      - ${server.server_name}: ${server.server_data?.length || 0} episodes`);
        });
      }
      
      console.log(`\n   👥 Cast:`);
      console.log(`      - Actors: ${sampleMovie.actor?.length || 0}`);
      console.log(`      - Directors: ${sampleMovie.director?.length || 0}`);
    } else {
      console.log('⚠️  No movies found in database');
    }

    // ============================================================
    // STEP 6: Verify Schema Consistency
    // ============================================================
    console.log('\n✅ STEP 6: Schema Validation...\n');
    
    const validations = [];
    
    // Check required indexes
    const movieIndexes = await Movie.collection.getIndexes();
    validations.push({
      test: 'Movie indexes',
      passed: Object.keys(movieIndexes).length >= 5,
      details: `${Object.keys(movieIndexes).length} indexes found`
    });
    
    // Check junction tables
    const hasCategoryRelations = afterStats.movieCategories > 0;
    validations.push({
      test: 'Category relationships',
      passed: hasCategoryRelations,
      details: `${afterStats.movieCategories} relations`
    });
    
    const hasCountryRelations = afterStats.movieCountries > 0;
    validations.push({
      test: 'Country relationships',
      passed: hasCountryRelations,
      details: `${afterStats.movieCountries} relations`
    });
    
    validations.forEach(v => {
      const icon = v.passed ? '✅' : '❌';
      console.log(`   ${icon} ${v.test}: ${v.details}`);
    });

    // ============================================================
    // Summary
    // ============================================================
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                    SUMMARY                                 ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    const allPassed = validations.every(v => v.passed);
    
    if (allPassed && result.savedMovies.length > 0) {
      console.log('🎉 SUCCESS! Hệ thống hoạt động hoàn hảo!\n');
      console.log('✅ Database connection: OK');
      console.log('✅ Shared models: OK');
      console.log('✅ Crawler functionality: OK');
      console.log('✅ Normalized relationships: OK');
      console.log('✅ Data integrity: OK');
      console.log('\n📚 Next steps:');
      console.log('   - Crawl more pages: npm run crawl:ophim:all');
      console.log('   - Crawl all sources: npm run crawl:all');
      console.log('   - View documentation: DATABASE_ARCHITECTURE.md');
    } else {
      console.log('⚠️  Some tests failed. Please review the output above.');
    }
    
    console.log('');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\n💡 Tips:');
    console.error('   1. Check MongoDB is running: mongod');
    console.error('   2. Verify .env configuration');
    console.error('   3. Ensure backend folder structure is correct');
    console.error('   4. Check network connection for API calls');
    console.error('');
    process.exit(1);
  } finally {
    await disconnect();
  }
}

async function getStats() {
  const [movies, categories, countries, movieCategories, movieCountries] = await Promise.all([
    Movie.countDocuments(),
    Category.countDocuments(),
    Country.countDocuments(),
    MovieCategory.countDocuments(),
    MovieCountry.countDocuments(),
  ]);

  return { movies, categories, countries, movieCategories, movieCountries };
}

// Run
quickStart().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
