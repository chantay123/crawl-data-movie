/**
 * Quick TMDB API Key Test
 */

require('dotenv').config();
const axios = require('axios');

async function quickTest() {
  const apiKey = process.env.TMDB_API_KEY;
  
  console.log('Testing TMDB API Key...\n');
  console.log('API Key:', apiKey ? apiKey.substring(0, 10) + '...' : 'NOT FOUND');
  console.log('Enabled:', process.env.ENABLE_TMDB_ENRICHMENT);
  console.log('');

  if (!apiKey) {
    console.log('❌ TMDB_API_KEY not found in .env\n');
    return;
  }

  try {
    // Test 1: Search movie
    console.log('Test 1: Searching for "Avatar"...');
    const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=Avatar&language=vi-VN`;
    const searchRes = await axios.get(searchUrl, { timeout: 10000 });
    
    if (searchRes.data.results && searchRes.data.results.length > 0) {
      const movie = searchRes.data.results[0];
      console.log('✅ Success!');
      console.log(`   Found: ${movie.title}`);
      console.log(`   TMDB ID: ${movie.id}`);
      console.log(`   Rating: ${movie.vote_average}/10`);
      console.log('');

      // Test 2: Get movie details
      console.log('Test 2: Getting movie details...');
      const detailUrl = `https://api.themoviedb.org/3/movie/${movie.id}?api_key=${apiKey}&append_to_response=credits,videos&language=vi-VN`;
      const detailRes = await axios.get(detailUrl, { timeout: 10000 });
      
      const cast = detailRes.data.credits?.cast || [];
      const videos = detailRes.data.videos?.results || [];
      
      console.log('✅ Success!');
      console.log(`   Title: ${detailRes.data.title}`);
      console.log(`   Cast: ${cast.length} actors`);
      console.log(`   Videos: ${videos.length} videos`);
      
      if (cast.length > 0) {
        console.log('\n   Top 3 Actors:');
        cast.slice(0, 3).forEach((actor, i) => {
          console.log(`   ${i+1}. ${actor.name} as ${actor.character}`);
        });
      }
      
      if (videos.length > 0) {
        const trailer = videos.find(v => v.type === 'Trailer' && v.site === 'YouTube');
        if (trailer) {
          console.log(`\n   Trailer: https://www.youtube.com/watch?v=${trailer.key}`);
        }
      }
      
      console.log('\n✅ TMDB API is working perfectly!\n');
      
    } else {
      console.log('⚠️ No results found\n');
    }
    
  } catch (error) {
    console.log('❌ Error:', error.message);
    
    if (error.response) {
      console.log('   Status:', error.response.status);
      console.log('   Data:', JSON.stringify(error.response.data, null, 2));
      
      if (error.response.status === 401) {
        console.log('\n💡 Fix: Invalid API Key. Get a new one from:');
        console.log('   https://www.themoviedb.org/settings/api\n');
      }
    } else {
      console.log('   Full error:', error);
    }
  }
}

quickTest().catch(console.error);
