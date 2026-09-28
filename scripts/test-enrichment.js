/**
 * Test TMDB Enrichment End-to-End
 * 
 * Test toàn bộ flow: API → Enrich → Save → Verify
 */

require('dotenv').config();
const db = require('../src/utils/db');
const TMDBService = require('../src/services/TMDBService');
const MovieService = require('../src/services/MovieService');
const { Movie } = require('../src/models');
const logger = require('../src/utils/logger');

async function testEnrichment() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     TMDB ENRICHMENT END-TO-END TEST                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  await db.connect();

  try {
    // Test movie data (giống data từ OPhim)
    const testMovie = {
      name: 'Venom: Kèo Cuối',
      slug: 'venom-keo-cuoi-test',
      origin_name: 'Venom: The Last Dance',
      year: 2024,
      type: 'single',
      status: 'completed',
      content: 'Mô tả ngắn từ OPhim...',
      thumb_url: 'https://ophim.com/thumb.jpg',
      poster_url: 'https://ophim.com/poster.jpg',
      actor: ['Tom Hardy'], // Chỉ có 1 người
      director: [],
      trailer_url: '',
      category: ['Hành Động', 'Khoa Học Viễn Tưởng'],
      country: ['Mỹ'],
      quality: 'HD',
      lang: 'Vietsub',
      time: '120 phút',
      episode_current: '1/1',
      episode_total: '1',
      episodes: [],
    };

    console.log('📝 Test Movie Data (BEFORE enrichment):');
    console.log('   Name:', testMovie.name);
    console.log('   Actors:', testMovie.actor);
    console.log('   Directors:', testMovie.director);
    console.log('   Trailer:', testMovie.trailer_url || '(none)');
    console.log('   Poster:', testMovie.poster_url.substring(0, 50) + '...');
    console.log('');

    // Step 1: Test TMDB enrichment
    console.log('1️⃣ Enriching with TMDB...');
    const enriched = await TMDBService.enrichMovieData(testMovie);
    
    console.log('   ✅ Enriched!');
    console.log('');
    console.log('📊 Enriched Data:');
    console.log('   TMDB ID:', enriched.tmdbId || '(not found)');
    console.log('   TMDB Type:', enriched.tmdbType || '(not found)');
    console.log('   Vote Average:', enriched.tmdbVoteAverage || 0);
    console.log('   Vote Count:', enriched.tmdbVoteCount || 0);
    console.log('');
    console.log('   Actors:', enriched.actor.length, 'people');
    if (enriched.actor.length > 0) {
      enriched.actor.slice(0, 5).forEach((name, i) => {
        console.log(`      ${i + 1}. ${name}`);
      });
      if (enriched.actor.length > 5) {
        console.log(`      ... and ${enriched.actor.length - 5} more`);
      }
    }
    console.log('');
    console.log('   Directors:', enriched.director.length, 'people');
    enriched.director.forEach(name => {
      console.log(`      - ${name}`);
    });
    console.log('');
    console.log('   Trailer:', enriched.trailerUrl || '(none)');
    console.log('   Poster:', enriched.posterUrl ? enriched.posterUrl.substring(0, 60) + '...' : '(none)');
    console.log('   Backdrop:', enriched.backdropUrl ? enriched.backdropUrl.substring(0, 60) + '...' : '(none)');
    console.log('');

    // Step 2: Save to database
    console.log('2️⃣ Saving to database...');
    const result = await MovieService.saveMovie(enriched, 'test', false); // false = already enriched
    
    console.log(`   ✅ ${result.isNew ? 'Created' : 'Updated'} in MongoDB`);
    console.log('');

    // Step 3: Verify in database
    console.log('3️⃣ Verifying data in MongoDB...');
    const saved = await Movie.findOne({ slug: 'venom-keo-cuoi-test' });
    
    if (!saved) {
      console.log('   ❌ Movie not found in database!');
      return;
    }

    console.log('   ✅ Found in database');
    console.log('');
    console.log('💾 Saved Data:');
    console.log('   Name:', saved.name);
    console.log('   Slug:', saved.slug);
    console.log('');
    console.log('   TMDB ID:', saved.tmdbId || '❌ NOT SAVED');
    console.log('   TMDB Type:', saved.tmdbType || '❌ NOT SAVED');
    console.log('   TMDB Vote Avg:', saved.tmdbVoteAverage || '❌ NOT SAVED');
    console.log('   TMDB Vote Count:', saved.tmdbVoteCount || '❌ NOT SAVED');
    console.log('');
    console.log('   Actors:', saved.actor.length);
    saved.actor.slice(0, 5).forEach((name, i) => {
      console.log(`      ${i + 1}. ${name}`);
    });
    console.log('');
    console.log('   Directors:', saved.director.length);
    saved.director.forEach(name => {
      console.log(`      - ${name}`);
    });
    console.log('');
    console.log('   Trailer:', saved.trailerUrl || '❌ NOT SAVED');
    console.log('   Poster:', saved.posterUrl ? saved.posterUrl.substring(0, 60) + '...' : '❌ NOT SAVED');
    console.log('   Backdrop:', saved.backdropUrl ? saved.backdropUrl.substring(0, 60) + '...' : '❌ NOT SAVED');
    console.log('');

    // Step 4: Comparison
    console.log('═══════════════════════════════════════════════════════════');
    console.log('                    COMPARISON                              ');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    
    const comparison = [
      ['Field', 'Before', 'After', 'Status'],
      ['─────', '──────', '─────', '──────'],
      ['Actors', testMovie.actor.length.toString(), saved.actor.length.toString(), saved.actor.length > 1 ? '✅' : '❌'],
      ['Directors', testMovie.director.length.toString(), saved.director.length.toString(), saved.director.length > 0 ? '✅' : '❌'],
      ['Trailer', testMovie.trailer_url ? 'Yes' : 'No', saved.trailerUrl ? 'Yes' : 'No', saved.trailerUrl ? '✅' : '❌'],
      ['TMDB ID', 'No', saved.tmdbId ? 'Yes' : 'No', saved.tmdbId ? '✅' : '❌'],
      ['Vote Avg', '0', saved.tmdbVoteAverage?.toString() || '0', saved.tmdbVoteAverage > 0 ? '✅' : '❌'],
    ];

    comparison.forEach(row => {
      console.log(`   ${row[0].padEnd(12)} ${row[1].padEnd(10)} ${row[2].padEnd(10)} ${row[3]}`);
    });
    console.log('');

    // Final verdict
    const allGood = 
      saved.tmdbId &&
      saved.actor.length > 1 &&
      saved.director.length > 0 &&
      saved.trailerUrl &&
      saved.tmdbVoteAverage > 0;

    if (allGood) {
      console.log('🎉 SUCCESS! TMDB enrichment is working perfectly!');
      console.log('');
      console.log('✅ All checks passed:');
      console.log('   • TMDB ID saved');
      console.log('   • Actors enriched');
      console.log('   • Directors added');
      console.log('   • Trailer added');
      console.log('   • Ratings saved');
    } else {
      console.log('⚠️  PARTIAL SUCCESS - Some data missing:');
      if (!saved.tmdbId) console.log('   ❌ TMDB ID not saved');
      if (saved.actor.length <= 1) console.log('   ❌ Actors not enriched');
      if (saved.director.length === 0) console.log('   ❌ Directors not added');
      if (!saved.trailerUrl) console.log('   ❌ Trailer not added');
      if (saved.tmdbVoteAverage === 0) console.log('   ❌ Ratings not saved');
    }
    console.log('');

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    await Movie.deleteOne({ slug: 'venom-keo-cuoi-test' });
    console.log('   ✅ Test movie deleted\n');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  } finally {
    await db.disconnect();
  }
}

testEnrichment().catch(console.error);
