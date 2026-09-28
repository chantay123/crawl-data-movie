/**
 * Debug Mongoose Connection Step-by-Step
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function debug() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.MONGODB_NAME || 'movie-api';
  
  console.log('🔍 Mongoose Debug\n');
  console.log('URI:', uri);
  console.log('DB:', dbName);
  console.log('Mongoose version:', mongoose.version);
  console.log();

  // Disable buffering
  mongoose.set('bufferCommands', false);
  console.log('✅ Buffering disabled\n');

  try {
    console.log('Step 1: Attempting to connect...');
    const conn = await mongoose.connect(uri, {
      dbName: dbName,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    
    console.log('✅ mongoose.connect() returned\n');
    console.log('Step 2: Check connection state');
    console.log('  readyState:', mongoose.connection.readyState);
    console.log('  host:', mongoose.connection.host);
    console.log('  port:', mongoose.connection.port);
    console.log('  name:', mongoose.connection.name);
    console.log();

    // Wait for open event
    if (mongoose.connection.readyState !== 1) {
      console.log('Step 3: Waiting for open event...');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for open')), 5000);
        mongoose.connection.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      console.log('✅ Open event fired\n');
    } else {
      console.log('Step 3: Already open\n');
    }

    // Define a simple schema
    console.log('Step 4: Define test schema...');
    const TestSchema = new mongoose.Schema({ name: String });
    const TestModel = mongoose.model('Test', TestSchema);
    console.log('✅ Schema defined\n');

    // Try a query
    console.log('Step 5: Try countDocuments...');
    const count = await TestModel.countDocuments().maxTimeMS(3000);
    console.log('✅ Query succeeded! Count:', count, '\n');

    console.log('🎉 Mongoose is working!\n');

    await mongoose.disconnect();
    console.log('✅ Disconnected');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\nStack:', error.stack);
    process.exit(1);
  }
}

debug();
