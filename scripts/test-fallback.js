require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const TrailerService = require('../src/services/TrailerService');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const Movie = require('../src/models').Movie;
  const movie = await Movie.findOne({ slug: 'vu-an-cuoi-cung-phan-1' });

  console.log('Before:', movie.trailer?.key || '(empty)');

  const trailer = await TrailerService.getTrailer(movie);
  console.log('Returned trailer.key:', trailer?.key);
  console.log('Returned trailer.name:', trailer?.name);

  // Re-fetch from DB to verify save
  const updated = await Movie.findOne({ slug: 'vu-an-cuoi-cung-phan-1' });
  console.log('After in DB:', updated.trailer?.key);
  console.log('tmdb.trailer_url:', updated.tmdb?.trailer_url);

  await mongoose.disconnect();
})();
