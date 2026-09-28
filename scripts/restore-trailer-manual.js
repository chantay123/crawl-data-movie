/**
 * Manual Trailer Restore Script
 *
 * Cho phép gán trailer thủ công bằng YouTube URL cho các phim cụ thể.
 * Dùng khi API trailer tự động bị quota/rate limit.
 *
 * Đọc data từ scripts/temp-restore.json:
 *   [
 *     { "slug": "tho-san-giac-thu-omegahorn", "name": "Thợ Săn..." },
 *     { "slug": "abc", "trailerUrl": "https://youtu.be/XX" },
 *     ...
 *   ]
 *
 * - Nếu item có `trailerUrl` riêng → dùng URL đó
 * - Nếu không có → dùng FALLBACK (Conan trailer) — chỉ để test/demo
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const { Movie } = require('../src/models');
const logger = require('../src/utils/logger');

// ===== FALLBACK CONFIG (dùng khi không có trailerUrl riêng) =====
const FALLBACK_KEY = 'Jrt1aUU2_Xs';
const FALLBACK_URL = `https://www.youtube.com/watch?v=${FALLBACK_KEY}`;
const FALLBACK_NAME = '(Official Trailer) THÁM TỬ LỪNG DANH CONAN: VIÊN ĐẠN ĐỎ | KC: 23.04.21';
const FALLBACK_PUBLISHED = new Date('2021-04-07T07:28:44.000Z');

function loadData() {
  const inline = process.argv[2];
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (e) {
      console.error('Invalid JSON argv:', e.message);
      return [];
    }
  }
  const jsonFile = path.join(__dirname, 'temp-restore.json');
  if (fs.existsSync(jsonFile)) {
    try {
      return JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    } catch (e) {
      console.error('Invalid JSON in temp-restore.json:', e.message);
      return [];
    }
  }
  return [];
}

function parseYouTubeKey(url) {
  if (!url) return null;
  const m1 = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m1) return m1[1];
  const m2 = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m2) return m2[1];
  const m3 = url.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (m3) return m3[1];
  return null;
}

/**
 * Build trailer object với 7 fields giống screenshot:
 *   { name, key, site, type, official, publishedAt, url }
 */
function buildTrailer(item, movieName) {
  let key;
  let url;
  if (item.trailerUrl) {
    key = parseYouTubeKey(item.trailerUrl);
    url = item.trailerUrl;
    if (!key) return null;
  } else {
    key = FALLBACK_KEY;
    url = FALLBACK_URL;
  }

  return {
    name: item.trailerName || item.name || `${FALLBACK_NAME} - ${movieName || ''}`.trim(),
    key,
    site: 'YouTube',
    type: 'Trailer',
    official: true,
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : FALLBACK_PUBLISHED,
    url,
  };
}

async function restoreTrailer(item) {
  const movie = await Movie.findOne({ slug: item.slug }).select('name').lean();
  if (!movie) return { ok: false, reason: 'movie_not_found' };

  const trailer = buildTrailer(item, movie.name);
  if (!trailer) return { ok: false, reason: 'invalid_url' };

  const result = await Movie.updateOne(
    { slug: item.slug },
    {
      $set: {
        trailer,
        'tmdb.trailer_url': trailer.url,
      },
    }
  );

  return {
    ok: result.matchedCount > 0,
    matched: result.matchedCount,
    modified: result.modifiedCount,
  };
}

async function main() {
  const data = loadData();
  if (!data || data.length === 0) {
    console.log('❌ Không có data. Tạo scripts/temp-restore.json hoặc truyền JSON qua argv');
    process.exit(1);
  }

  await mongoose.connect(config.mongodb.uri, {
    dbName: config.mongodb.name,
    serverSelectionTimeoutMS: 10000,
  });
  logger.info(`Connected to MongoDB (db=${config.mongodb.name})`);

  let success = 0;
  let failed = 0;
  for (const item of data) {
    try {
      const res = await restoreTrailer(item);
      if (res.ok) {
        success++;
        logger.info(`✅ ${item.slug}: updated (matched=${res.matched}, modified=${res.modified})`);
      } else {
        failed++;
        logger.warn(`❌ ${item.slug}: ${res.reason || 'movie not found'}`);
      }
    } catch (err) {
      failed++;
      logger.error(`❌ ${item.slug}: ${err.message}`);
    }
  }

  logger.info(`\n=== Restore complete: ${success} success, ${failed} failed ===`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
