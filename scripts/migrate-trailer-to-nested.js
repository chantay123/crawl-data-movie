/**
 * Migration: Legacy trailer fields → nested Movie.trailer
 *
 * Legacy top-level fields that may exist on Movie docs:
 *   - trailerUrl          (string)
 *   - trailerKey          (string - YouTube key)
 *   - youtubeTrailer      (object or string)
 *   - youtubeVideoId      (string)
 *
 * Goal: move them into the nested `trailer` object and remove duplicates.
 *
 * Idempotent: safe to re-run. Only touches movies that still have legacy fields
 * OR have a tmdb.trailer_url but no nested trailer.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');

async function run() {
  console.log('🔄 Migrating legacy trailer fields → nested trailer object...\n');

  await mongoose.connect(config.mongodb.uri, { dbName: config.mongodb.name });
  const { Movie } = require('../src/models');

  const cursor = Movie.find({
    $or: [
      { trailerUrl: { $exists: true } },
      { trailerKey: { $exists: true } },
      { youtubeTrailer: { $exists: true } },
      { youtubeVideoId: { $exists: true } },
      { 'tmdb.trailer_url': { $exists: true, $ne: '' }, 'trailer.key': null }
    ]
  }).cursor();

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for await (const movie of cursor) {
    try {
      // Skip if already has a real nested trailer
      if (movie.trailer && movie.trailer.key) {
        skipped++;
        // Still clean up legacy fields
        await Movie.updateOne(
          { _id: movie._id },
          { $unset: { trailerUrl: 1, trailerKey: 1, youtubeTrailer: 1, youtubeVideoId: 1 } }
        );
        continue;
      }

      // Pick the best available legacy key
      const key =
        movie.trailerKey ||
        movie.youtubeVideoId ||
        (movie.youtubeTrailer && (movie.youtubeTrailer.key || movie.youtubeTrailer.videoId)) ||
        null;

      if (!key && !movie.tmdb?.trailer_url) {
        skipped++;
        continue;
      }

      const trailerUrl = movie.trailerUrl
        || movie.tmdb?.trailer_url
        || (key ? `https://www.youtube.com/watch?v=${key}` : '');

      const nestedTrailer = {
        name: '',
        key: key || '',
        site: 'YouTube',
        type: 'Trailer',
        official: false,
        publishedAt: null,
        url: trailerUrl,
        updatedAt: new Date(),
        viewCount: 0
      };

      await Movie.updateOne(
        { _id: movie._id },
        {
          $set: {
            trailer: nestedTrailer,
            'tmdb.trailer_url': trailerUrl
          },
          $unset: {
            trailerUrl: 1,
            trailerKey: 1,
            youtubeTrailer: 1,
            youtubeVideoId: 1
          }
        }
      );

      updated++;
      if (updated % 100 === 0) console.log(`  Processed ${updated}...`);
    } catch (err) {
      errors++;
      console.error(`  ❌ ${movie.name}: ${err.message}`);
    }
  }

  console.log('\n✅ Migration complete.');
  console.log(`   updated:  ${updated}`);
  console.log(`   skipped:  ${skipped}`);
  console.log(`   errors:   ${errors}`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});