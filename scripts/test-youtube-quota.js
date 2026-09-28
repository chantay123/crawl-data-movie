require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

(async () => {
  const apiKey = config.youtube.apiKey;
  console.log('API key:', apiKey ? `${apiKey.slice(0, 10)}...${apiKey.slice(-4)}` : '(none)');

  // Test 1: simple search
  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: 'test',
        type: 'video',
        maxResults: 1,
        key: apiKey,
      },
      timeout: 15000,
    });
    console.log('✅ Search OK');
  } catch (err) {
    console.log(`❌ Search status=${err.response?.status} code=${err.code}:`);
    console.log(`   message: ${err.response?.data?.error?.message || err.message}`);
    if (err.response?.status === 429) {
      console.log('\n👉 Quota hết - chờ reset hoặc tạo key mới');
    }
  }

  // Test 2: network
  try {
    await axios.get('https://www.google.com', { timeout: 8000 });
    console.log('✅ Network OK');
  } catch (err) {
    console.log(`❌ Network: ${err.message}`);
  }
})();
