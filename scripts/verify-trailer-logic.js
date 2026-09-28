require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const TrailerService = require('../src/services/TrailerService');

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const { Movie } = require('../src/models');

  // Find any movie (force test on one that already has trailer to verify cached path)
  const all = await Movie.find({}).select('name slug tmdb trailer').limit(3).lean();
  console.log(`Found ${all.length} movies to test with.`);

  for (const m of all) {
    console.log('\n=== Test:', m.name, '===');
    console.log('  Has tmdb.id?', !!m.tmdb?.id, m.tmdb?.id);
    console.log('  Has trailer.key?', !!m.trailer?.key, m.trailer?.key);
    // Load full mongoose doc for saveTrailer
    const movie = await Movie.findById(m._id);
    const before = movie.trailer?.key || '(empty)';
    const trailer = await TrailerService.getTrailer(movie);
    const after = movie.trailer?.key || '(empty)';
    console.log('  Before:', before);
    console.log('  Returned:', trailer?.key || '(null)');
    console.log('  After:', after);
    console.log('  Should be unchanged?', before === after);
  }

  await mongoose.disconnect();
})();
