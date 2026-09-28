/**
 * Verify MongoDB connection + model loading
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function verify() {
  console.log('🔍 Verifying MongoDB Setup\n');

  try {
    // 1. Tắt buffering globally
    mongoose.set('bufferCommands', false);
    console.log('✅ Disabled command buffering\n');

    // 2. Connect
    const uri = process.env.MONGODB_URI;
    console.log(`Connecting to: ${uri}`);
    
    await mongoose.connect(uri, {
      dbName: process.env.MONGODB_NAME,
      serverSelectionTimeoutMS: 10000,
    });

    console.log(`✅ Connected (readyState: ${mongoose.connection.readyState})\n`);

    // 3. Wait for 'open' event
    if (mongoose.connection.readyState !== 1) {
      console.log('Waiting for connection to open...');
      await new Promise(resolve => mongoose.connection.once('open', resolve));
      console.log('✅ Connection opened\n');
    }

    // 4. Load model
    console.log('Loading Movie model...');
    const Movie = require('../../backend/src/models/Movie');
    console.log(`✅ Model loaded: ${Movie.modelName}\n`);

    // 5. Test query with timeout
    console.log('Testing query...');
    const count = await Movie.countDocuments().maxTimeMS(5000);
    console.log(`✅ Query succeeded: ${count} movies\n`);

    // 6. Test transaction (for MovieService)
    console.log('Testing transaction...');
    const session = await mongoose.startSession();
    session.startTransaction();
    const testDoc = await Movie.findOne().session(session);
    await session.abortTransaction();
    session.endSession();
    console.log('✅ Transaction works\n');

    console.log('🎉 All checks passed!\n');

  } catch (error) {
    console.error('\n❌ Verification failed:', error.message);
    console.error('\nStack:', error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

verify();
