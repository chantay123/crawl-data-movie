/**
 * Quick MongoDB Connection Test
 * 
 * Chạy: node scripts/test-connection-quick.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function testConnection() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     MONGODB CONNECTION QUICK TEST                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_NAME;

  console.log('Configuration:');
  console.log(`  URI: ${uri}`);
  console.log(`  Database: ${dbName}\n`);

  console.log('Testing connection...');

  try {
    // Disable buffering để fail fast
    mongoose.set('bufferCommands', false);
    mongoose.set('bufferTimeoutMS', 5000);

    await mongoose.connect(uri, {
      dbName: dbName,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    console.log('✅ Connection successful!\n');

    // Test ping
    const admin = mongoose.connection.db.admin();
    const info = await admin.ping();
    console.log('✅ Ping successful:', info);

    // Show database info
    const stats = await mongoose.connection.db.stats();
    console.log('\nDatabase stats:');
    console.log(`  Collections: ${stats.collections}`);
    console.log(`  Data size: ${(stats.dataSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Indexes: ${stats.indexes}`);
    console.log(`  Storage size: ${(stats.storageSize / 1024 / 1024).toFixed(2)} MB`);

    // List collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`\nCollections (${collections.length}):`);
    collections.forEach(col => {
      console.log(`  - ${col.name}`);
    });

    console.log('\n✅ All tests passed!\n');
    console.log('Next steps:');
    console.log('  1. Run: npm run quick-start');
    console.log('  2. Or run: npm run crawl:ophim\n');

  } catch (error) {
    console.error('\n❌ Connection failed!\n');
    console.error('Error:', error.message);
    console.error('\n💡 Troubleshooting:');
    console.error('  1. Make sure MongoDB is running:');
    console.error('     - Windows: Check Services for "MongoDB"');
    console.error('     - Mac/Linux: Run "mongod" or "sudo systemctl start mongodb"');
    console.error('  2. Check if port 27017 is available');
    console.error('  3. Verify MONGODB_URI in .env file');
    console.error('  4. Try connecting with mongo shell: mongosh\n');
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

testConnection().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
