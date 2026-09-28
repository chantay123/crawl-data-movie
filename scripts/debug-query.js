require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const db = mongoose.connection.db;

  // Try raw MongoDB query
  const movies1 = await db.collection('movies').find({
    $or: [
      { 'tmdb.id': '' },
      { trailer: { $exists: false } },
      { trailer: null }
    ]
  }).limit(3).toArray();
  console.log('Raw query1 count:', movies1.length);
  for (const m of movies1) {
    console.log('  -', m.name, '| tmdb:', JSON.stringify(m.tmdb), '| trailer:', JSON.stringify(m.trailer));
  }

  // Try with $or broader
  const movies2 = await db.collection('movies').find({
    $or: [
      { 'tmdb.id': { $exists: false } },
      { 'tmdb.id': '' },
      { 'tmdb.id': null },
      { trailer: { $exists: false } },
      { trailer: null },
      { 'trailer.key': '' },
      { 'trailer.key': null }
    ]
  }).limit(3).toArray();
  console.log('\nRaw query2 count:', movies2.length);
  for (const m of movies2) {
    console.log('  -', m.name);
  }

  // Count total
  const total = await db.collection('movies').countDocuments({});
  console.log('\nTotal movies in collection:', total);

  await mongoose.disconnect();
})();
