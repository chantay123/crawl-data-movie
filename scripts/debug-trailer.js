/**
 * Debug Trailer - Check raw TMDB API response
 */

require('dotenv').config();
const axios = require('axios');

async function debugTrailer() {
  const TMDB_API_KEY = process.env.TMDB_API_KEY;
  const BASE_URL = 'https://api.themoviedb.org/3';

  console.log('🔍 TMDB API Debug\n');
  console.log(`API Key: ${TMDB_API_KEY ? TMDB_API_KEY.substring(0, 10) + '...' : '❌ MISSING'}\n`);

  try {
    // Test với movie ID cụ thể (Avengers: Endgame = 299534)
    const tmdbId = 299534;
    
    console.log(`📦 Fetching videos for movie ID: ${tmdbId}\n`);
    
    const response = await axios.get(`${BASE_URL}/movie/${tmdbId}/videos`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'en-US'
      },
      timeout: 10000
    });

    console.log('✅ API Response Status:', response.status);
    console.log('');
    
    const results = response.data.results || [];
    console.log(`📊 Total videos: ${results.length}\n`);

    if (results.length > 0) {
      console.log('='.repeat(80));
      console.log('RAW VIDEO DATA (First 3):');
      console.log('='.repeat(80));
      
      results.slice(0, 3).forEach((video, index) => {
        console.log(`\n[${index + 1}] VIDEO OBJECT:`);
        console.log(JSON.stringify(video, null, 2));
      });

      console.log('\n' + '='.repeat(80));
      console.log('FIELD CHECK:');
      console.log('='.repeat(80));
      
      const firstVideo = results[0];
      console.log(`key: "${firstVideo.key}" (${typeof firstVideo.key})`);
      console.log(`name: "${firstVideo.name}" (${typeof firstVideo.name})`);
      console.log(`site: "${firstVideo.site}" (${typeof firstVideo.site})`);
      console.log(`type: "${firstVideo.type}" (${typeof firstVideo.type})`);
      console.log(`official: ${firstVideo.official} (${typeof firstVideo.official})`);
      console.log(`published_at: ${firstVideo.published_at || 'null'} (${typeof firstVideo.published_at})`);
      
      console.log('\n' + '='.repeat(80));
      console.log('MAPPED OBJECT:');
      console.log('='.repeat(80));
      
      const mapped = {
        key: firstVideo.key,
        name: firstVideo.name,
        type: firstVideo.type,
        site: firstVideo.site,
        official: firstVideo.official || false,
        publishedAt: firstVideo.published_at || null,
        url: `https://www.youtube.com/watch?v=${firstVideo.key}`
      };
      
      console.log(JSON.stringify(mapped, null, 2));
      
    } else {
      console.log('❌ No videos found');
    }

  } catch (error) {
    console.error('\n❌ ERROR:');
    
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Message: ${error.response.data?.status_message || error.message}`);
      
      if (error.response.status === 401) {
        console.error('\n   🔧 Fix: Invalid TMDB API key');
        console.error('       Get key from: https://www.themoviedb.org/settings/api');
      }
    } else if (error.code) {
      console.error(`   Code: ${error.code}`);
      console.error(`   Message: ${error.message}`);
    } else {
      console.error(`   ${error.message}`);
    }
  }
}

debugTrailer();
