require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const { Movie } = require('../src/models');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const total = await Movie.countDocuments({});
  const noTrailer = await Movie.countDocuments({
    $or: [{ trailer: null }, { trailer: { $exists: false } }, { 'trailer.key': '' }]
  });
  const noTmdbId = await Movie.countDocuments({
    $or: [{ 'tmdb.id': null }, { 'tmdb.id': '' }, { tmdb: null }, { tmdb: { $exists: false } }]
  });
  console.log({ total, noTrailer, noTmdbId });

  // Sample one
  const sample = await Movie.findOne({}).select('name tmdb trailer').lean();
  console.log('Sample:', JSON.stringify(sample, null, 2));

  await mongoose.disconnect();
})();
