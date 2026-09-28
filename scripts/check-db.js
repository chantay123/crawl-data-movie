require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const { Movie } = require('../src/models');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });

  const total = await Movie.countDocuments({});
  const withTrailer = await Movie.countDocuments({ 'trailer.key': { $exists: true, $ne: '' } });
  const fallback = await Movie.countDocuments({ 'trailer.key': 'Jrt1aUU2_Xs' });
  const noTrailer = await Movie.countDocuments({
    $or: [
      { trailer: null },
      { 'trailer.key': '' },
      { 'trailer.key': null },
      { 'trailer.key': { $exists: false } }
    ]
  });

  console.log({
    total,
    withTrailer,
    fallbackConan: fallback,
    noTrailer
  });

  // Sample 5 latest docs
  const samples = await Movie.find({}).sort({ updatedAt: -1 }).limit(5).select('name slug updatedAt trailer').lean();
  console.log('\nLatest 5:');
  samples.forEach(s => console.log(`  - ${s.name} | updated: ${s.updatedAt} | trailer.key: ${s.trailer?.key || '(empty)'}`));

  await mongoose.disconnect();
})();
