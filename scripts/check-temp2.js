require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const db = mongoose.connection.db;

  const m = await db.collection('movies').findOne({ slug: 'tho-san-giac-thu-omegahorn' });
  console.log('tho-san-giac-thu-omegahorn:', m ? 'FOUND' : 'NOT_FOUND');
  if (m) {
    console.log(`  Has trailer.key? ${m.trailer?.key || '❌ NO'}`);
    console.log(`  createdAt: ${m.createdAt?.toISOString?.()}`);
    console.log(`  updatedAt: ${m.updatedAt?.toISOString?.()}`);
  }

  // Phim nào không có trailer?
  const noTrailer = await db.collection('movies').find({
    $or: [
      { trailer: { $exists: false } },
      { trailer: null },
      { 'trailer.key': { $exists: false } },
      { 'trailer.key': '' },
    ]
  }).project({ slug: 1, name: 1, createdAt: 1 }).toArray();
  console.log(`\nMovies WITHOUT trailer: ${noTrailer.length}`);
  noTrailer.forEach(m => console.log(`  ❌ ${m.slug} (${m.createdAt?.toISOString?.()})`));

  const total = await db.collection('movies').countDocuments({});
  const withKey = await db.collection('movies').countDocuments({ 'trailer.key': { $exists: true, $ne: '' } });
  console.log(`\nTotal: ${total}, With trailer: ${withKey}, Without: ${total - withKey}`);

  await mongoose.disconnect();
})();
