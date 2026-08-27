/**
 * Export dữ liệu từ MongoDB ra JSON backup
 *
 * Usage: node scripts/export-json.js
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/utils/db');
const Movie = require('../src/models/Movie');
const Category = require('../src/models/Category');
const config = require('../src/config');
const logger = require('../src/utils/logger');

async function main() {
  await db.connect();

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = config.output.jsonDir;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const movies = await Movie.find().lean();
  const categories = await Category.find().lean();

  const moviesFile = path.join(outDir, `movies-${ts}.json`);
  const catsFile = path.join(outDir, `categories-${ts}.json`);

  fs.writeFileSync(moviesFile, JSON.stringify(movies, null, 2));
  fs.writeFileSync(catsFile, JSON.stringify(categories, null, 2));

  logger.info(`Exported ${movies.length} movies → ${moviesFile}`);
  logger.info(`Exported ${categories.length} categories → ${catsFile}`);

  await db.disconnect();
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
