require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const TrailerService = require('../src/services/TrailerService');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const { Movie } = require('../src/models');

  // Find a movie and FORCE clear its trailer + tmdb.id to simulate "no data"
  const all = await Movie.find({}).limit(1).lean();
  if (!all.length) {
    console.log('No movies in DB!');
    await mongoose.disconnect();
    return;
  }
  const target = all[0];
  console.log('Test movie:', target.name);

  // Step 1: Clear trailer + tmdb.id
  await Movie.updateOne(
    { _id: target._id },
    { $unset: { trailer: 1, 'tmdb.id': 1, 'tmdb.trailer_url': 1 } }
  );
  console.log('Cleared trailer + tmdb.id');

  // Step 2: Load fresh doc and call getTrailer
  const movie = await Movie.findById(target._id);
  console.log('Before getTrailer: trailer.key =', movie.trailer?.key || '(empty)');

  const trailer = await TrailerService.getTrailer(movie);

  console.log('\n=== RESULT ===');
  console.log('Returned trailer:', trailer ? trailer.key : 'null');
  console.log('Expected: null (since TMDB fail + YouTube 429)');

  // Step 3: Reload from DB to verify nothing was saved
  const reloaded = await Movie.findById(target._id);
  console.log('\n=== DB STATE AFTER ===');
  console.log('trailer.key:', reloaded.trailer?.key || '(empty)');
  console.log('tmdb.trailer_url:', reloaded.tmdb?.trailer_url || '(empty)');
  console.log('Expected: empty (no save)');

  await mongoose.disconnect();
})();
