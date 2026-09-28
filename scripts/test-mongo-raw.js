/**
 * Test MongoDB connection - RAW (không dùng Mongoose)
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function test() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.MONGODB_NAME || 'movie-api';
  
  console.log('🔍 Testing MongoDB Connection (Raw Driver)\n');
  console.log(`URI: ${uri}`);
  console.log(`Database: ${dbName}\n`);

  let client;
  
  try {
    console.log('Connecting...');
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    
    await client.connect();
    console.log('✅ Connected!\n');

    const db = client.db(dbName);
    
    // Test ping
    console.log('Testing ping...');
    await db.admin().ping();
    console.log('✅ Ping succeeded\n');

    // Test collections
    console.log('Listing collections...');
    const collections = await db.listCollections().toArray();
    console.log(`✅ Found ${collections.length} collections:`);
    collections.forEach(c => console.log(`   - ${c.name}`));
    console.log();

    // Test query
    if (collections.some(c => c.name === 'movies')) {
      console.log('Testing query on movies collection...');
      const count = await db.collection('movies').countDocuments();
      console.log(`✅ Count: ${count} movies\n`);
    }

    console.log('🎉 MongoDB is working!\n');
    console.log('Issue is likely with Mongoose, not MongoDB itself.');

  } catch (error) {
    console.error('\n❌ Connection failed:', error.message);
    console.error('\nPossible causes:');
    console.error('  1. MongoDB is not running');
    console.error('     → Run: mongod');
    console.error('  2. Wrong URI or port');
    console.error('     → Check MONGODB_URI in .env');
    console.error('  3. Firewall blocking connection');
    console.error('     → Check Windows Firewall\n');
    
    process.exit(1);
  } finally {
    if (client) await client.close();
  }
}

test();
