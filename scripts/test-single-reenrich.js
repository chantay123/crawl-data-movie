require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const TrailerService = require('../src/services/TrailerService');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const { Movie } = require('../src/models');

  // Pick movie with tmdb.id but no trailer
  const movie = await Movie.findOne({
    'tmdb.id': { $exists: true, $ne: '' },
    $or: [
      { trailer: null },
      { trailer: { $exists: false } },
      { 'trailer.key': '' },
      { 'trailer.key': null }
    ]
  });

  if (!movie) {
    console.log('No movies with tmdb.id need trailer.');
    // List all movies with tmdb.id
    const all = await Movie.find({}).select('name tmdb.id trailer.key').limit(20).lean();
    console.log('\nAll movies:');
    for (const m of all) {
      console.log(`  ${m.name} | tmdb.id=${m.tmdb?.id || 'none'} | trailer.key=${m.trailer?.key || 'empty'}`);
    }
    await mongoose.disconnect();
    return;
  }

  console.log('Testing with:', movie.name);
  console.log('  tmdb.id:', movie.tmdb.id);

  const trailer = await TrailerService.getTrailer(movie);
  console.log('\n=== RESULT ===');
  console.log('Returned trailer:', trailer ? trailer.key : 'null');

  const reloaded = await Movie.findById(movie._id);
  console.log('Saved to DB:', reloaded.trailer?.key || '(empty)');

  await mongoose.disconnect();
})();
