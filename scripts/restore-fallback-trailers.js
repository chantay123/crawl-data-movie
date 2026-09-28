require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');

const FALLBACK_TRAILER = {
  name: '(Official Trailer) THÁM TỬ LỪNG DANH CONAN: VIÊN ĐẠN ĐỎ | KC: 23.04.21',
  key: 'Jrt1aUU2_Xs',
  site: 'YouTube',
  type: 'Trailer',
  official: true,
  publishedAt: new Date('2021-04-07T07:28:44.000Z'),
  url: 'https://www.youtube.com/watch?v=Jrt1aUU2_Xs',
};

(async () => {
  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const { Movie } = require('../src/models');

  // Find movies without trailer
  const movies = await Movie.find({
    $or: [
      { trailer: null },
      { trailer: { $exists: false } },
      { 'trailer.key': '' },
      { 'trailer.key': null }
    ]
  }).select('name').lean();

  console.log(`Found ${movies.length} movies to restore trailer:\n`);
  for (const m of movies) console.log(`  - ${m.name}`);

  if (!movies.length) {
    console.log('Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log('\nRestoring FALLBACK_TRAILER (Conan)...');

  let success = 0;
  for (const m of movies) {
    try {
      const trailer = {
        ...FALLBACK_TRAILER,
        name: `${FALLBACK_TRAILER.name} - ${m.name}`.trim(),
      };
      await Movie.updateOne(
        { _id: m._id },
        {
          $set: {
            trailer: {
              name: trailer.name,
              key: trailer.key,
              site: trailer.site,
              type: trailer.type,
              official: trailer.official,
              publishedAt: trailer.publishedAt,
              url: trailer.url,
            },
            'tmdb.trailer_url': trailer.url,
            updatedAt: new Date(),
          },
        }
      );
      success++;
      console.log(`  ✅ ${m.name}`);
    } catch (err) {
      console.error(`  ❌ ${m.name}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${success}/${movies.length} restored.`);

  // Verify
  const withTrailer = await Movie.countDocuments({ 'trailer.key': FALLBACK_TRAILER.key });
  console.log(`\nDB now has ${withTrailer} movies with fallback trailer key.`);

  await mongoose.disconnect();
})();
