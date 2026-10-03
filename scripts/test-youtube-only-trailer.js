/**
 * Test: Trailer pipeline YouTube-ONLY (không TMDB).
 *
 * Kiểm chứng:
 *   #1  Không còn TMDB trong flow trailer (không import, không log TMDB)
 *   #2  Query đúng thứ tự: "<title> official trailer" → "<title> trailer", type=video, maxResults=5
 *   #3  Lọc theo từ khóa: trailer / official trailer / teaser / official teaser
 *   #4  Ưu tiên: Official trailer > Trailer > Teaser
 *   #5  Lưu trailer vào MongoDB (OBJECT) TRƯỚC log "Created/Updated movie"
 *   #6  429/QUOTA_EXCEEDED/CIRCUIT_OPEN → không retry, trailer=null, log
 *       "[Trailer] ⚠️ YouTube unavailable → trailer=null, retry later", KHÔNG fail movie
 *   #7  Log "[Trailer] ✅ YouTube trailer found: <videoId>" + "[Trailer] 💾 Trailer saved to Movie"
 *   #8  KHÔNG log: "trying TMDB fallback source" / "tmdb=SKIPPED" / "Trailer untouched"
 *   #9  Circuit breaker có cooldown hợp lý + retry được sau cooldown
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/XomPhim';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ${GREEN}✅${RESET} ${name}`); }
  else { fail++; console.log(`  ${RED}❌${RESET} ${name}${detail ? `\n       ${detail}` : ''}`); }
  return ok;
}

const MOVIE = {
  name: 'Những chủ nhân vũ trụ: Khải huyền',
  origin_name: 'Masters of the Universe: Revelation',
  slug: 'test-youtube-only-trailer',
  year: 2021,
  type: 'series',
  content: 'test',
  episodes: [],
  category: [],
  country: [],
  actor: [],
  director: [],
};

async function main() {
  const TrailerService = require('../src/services/TrailerService');
  const YouTubeService = require('../src/services/YouTubeService');
  const rateLimiter = require('../src/utils/youtubeRateLimiter');
  const trailerState = require('../src/utils/trailerState');
  const MovieService = require('../src/services/MovieService');
  const { Movie } = require('../src/models');
  const logger = require('../src/utils/logger');

  await mongoose.connect(MONGO);
  console.log(`${GREEN}✅ Connected${RESET} (${MONGO})\n`);

  // Capture toàn bộ log
  const logs = [];
  const oi = logger.info.bind(logger), ow = logger.warn.bind(logger);
  const oe = logger.error.bind(logger), od = logger.debug.bind(logger);
  logger.info = (...a) => { logs.push(a.join(' ')); oi(...a); };
  logger.warn = (...a) => { logs.push(a.join(' ')); ow(...a); };
  logger.error = (...a) => { logs.push(a.join(' ')); oe(...a); };
  logger.debug = (...a) => { logs.push(a.join(' ')); od(...a); };
  const allLogs = () => logs.join('\n');

  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(74));
  console.log('A. STATIC CHECKS — TMDB phải bị gỡ khỏi flow trailer (#1)');
  console.log('═'.repeat(74));
  const fs = require('fs');
  const trailerSrc = fs.readFileSync('src/services/TrailerService.js', 'utf8');
  check('TrailerService KHÔNG import TMDBService',
    !/require\(['"]\.\/TMDBService['"]\)/.test(trailerSrc));
  check('TrailerService KHÔNG còn method searchTMDB',
    !/searchTMDB\s*\(/.test(trailerSrc));
  check('TrailerService KHÔNG gọi getMovieVideos',
    !trailerSrc.includes('getMovieVideos'));

  const tmdbSrc = fs.readFileSync('src/services/TMDBService.js', 'utf8');
  const enrichBody = tmdbSrc.slice(tmdbSrc.indexOf('async enrichMovieData'));
  check('enrichMovieData KHÔNG fetch videos nữa',
    !enrichBody.slice(0, enrichBody.indexOf('return enriched')).includes('getMovieVideos'));
  console.log('');

  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(74));
  console.log('B. QUERY BUILDING (#2) — đúng thứ tự, chỉ 2 query');
  console.log('═'.repeat(74));
  const queries = YouTubeService._buildQueries(MOVIE.name, MOVIE.year, MOVIE.origin_name);
  console.log('  queries =', JSON.stringify(queries));
  check('Query[0] === "<title> official trailer"',
    queries[0] === `${MOVIE.name} official trailer`, `got: ${queries[0]}`);
  check('Query[1] === "<title> trailer"',
    queries[1] === `${MOVIE.name} trailer`, `got: ${queries[1]}`);
  check('Chỉ 2 query cho tên khớp title (tiết kiệm quota)',
    queries.length === 2, `got ${queries.length}`);
  check('maxResults = 5', YouTubeService.maxResults === 5, `got ${YouTubeService.maxResults}`);
  check('YOUTUBE_RATE_LIMIT_MAX_RETRIES = 0 (không retry 429)',
    YouTubeService.rateLimitMaxRetries === 0, `got ${YouTubeService.rateLimitMaxRetries}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(74));
  console.log('C. FILTER + RANKING (#3, #4)');
  console.log('═'.repeat(74));
  const mk = (title, ch = 'Studio') => ({ snippet: { title, channelTitle: ch }, id: { videoId: 'vid_' + title.slice(0, 8).replace(/\W/g, '') } });
  const items = [
    mk('Một video review phim hoàn toàn không liên quan', 'Review Channel'),
    mk('Những chủ nhân vũ trụ Khải huyền Official Teaser', 'Netflix'),
    mk('Những chủ nhân vũ trụ: Khải huyền Trailer', 'SomeChannel'),
    mk('Những chủ nhân vũ trụ: Khải huyền OFFICIAL TRAILER 4K', 'Official Movies'),
    mk('Những chủ nhân vũ trụ Khải huyền - Music Video', 'VEVO'),
  ];
  const filtered = items.filter((i) => YouTubeService._isPlausibleVideo(i, MOVIE.name));
  console.log('  sau filter:', filtered.map((i) => i.snippet.title).join(' || '));
  check('Loại được "review" (không có từ khóa trailer/teaser)',
    !filtered.some((i) => i.snippet.title.includes('review')));
  check('Loại được VEVO music video',
    !filtered.some((i) => i.snippet.title.includes('VEVO')));
  check('Giữ được cả trailer, official trailer, teaser',
    filtered.length === 3, `got ${filtered.length}`);

  const best = YouTubeService._findBestTrailer(filtered, MOVIE.name);
  console.log('  best =', best.snippet.title);
  check('Chọn OFFICIAL TRAILER (ưu tiên cao nhất)',
    best.snippet.title.includes('OFFICIAL TRAILER'), `got: ${best.snippet.title}`);
  check('_detectType(official trailer) = Trailer',
    YouTubeService._detectType('X OFFICIAL TRAILER') === 'Trailer');
  check('_detectType(teaser) = Teaser',
    YouTubeService._detectType('X Official Teaser') === 'Teaser');
  console.log('');

  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(74));
  console.log('D. RATE LIMIT PATH (#6, #9) — không retry, trailer=null');
  console.log('═'.repeat(74));
  const origSearch = YouTubeService.searchTrailer.bind(YouTubeService);
  let callCount = 0;
  YouTubeService.searchTrailer = async () => {
    callCount++;
    const e = new Error('[YouTube] QUOTA_EXCEEDED for test');
    e.code = 'QUOTA_EXCEEDED';
    e.retryAfterMs = 30000;
    throw e;
  };

  await Movie.deleteMany({ slug: MOVIE.slug });
  const seeded = await Movie.create({ ...MOVIE, trailer: null, trailerJobStatus: 'OK' });
  const doc1 = await Movie.findById(seeded._id).lean();

  const r1 = await TrailerService.getTrailer(doc1, { force: true });
  const db1 = await Movie.findById(seeded._id).lean();
  check('status = RATE_LIMITED', r1.status === 'RATE_LIMITED', `got ${r1.status}`);
  check('YouTube KHÔNG bị retry lặp lại (1 lần gọi)', callCount === 1, `calls=${callCount}`);
  check('Movie.trailer giữ null', db1.trailer === null, `got ${JSON.stringify(db1.trailer)}`);
  check('trailerJobStatus = RATE_LIMITED', db1.trailerJobStatus === 'RATE_LIMITED');
  check('trailerRetryAt được set (retry sau)', !!db1.trailerRetryAt);
  check('Log "⚠️ YouTube unavailable → trailer=null, retry later"',
    allLogs().includes('YouTube unavailable → trailer=null, retry later'));
  YouTubeService.searchTrailer = origSearch;
  console.log('');

  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(74));
  console.log('E. CIRCUIT BREAKER (#9) — cooldown hợp lý, mở lại được');
  console.log('═'.repeat(74));
  const cooldown = rateLimiter.cb.cooldownMs;
  check('Cooldown ≤ 10 phút (không khóa quá lâu)', cooldown <= 10 * 60 * 1000,
    `cooldown=${Math.round(cooldown / 60000)} phút`);

  // Khi circuit OPEN → isAvailable() PHẢI = false (yêu cầu #6: không retry).
  rateLimiter.cb.state = 'OPEN';
  rateLimiter.cb.openedAt = Date.now();
  rateLimiter.globalCooldownUntil = 0;
  check('isAvailable() = false khi circuit OPEN', YouTubeService.isAvailable() === false);

  // Giả lập hết cooldown → phải mở lại được
  rateLimiter.cb.openedAt = Date.now() - cooldown - 1000;
  rateLimiter.globalCooldownUntil = 0;
  rateLimiter.cb.state = 'HALF_OPEN';
  check('Sau cooldown → isAvailable() = true (retry được)',
    YouTubeService.isAvailable() === true);
  rateLimiter.cb.state = 'CLOSED';
  rateLimiter.cb.failureCount = 0;
  console.log('');

  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(74));
  console.log('F. HAPPY PATH qua MovieService.saveMovie (#5, #7)');
  console.log('═'.repeat(74));
  // Mock kết quả YouTube (không tốn quota thật)
  YouTubeService.searchTrailer = async () => ({
    name: 'Những chủ nhân vũ trụ: Khải huyền OFFICIAL TRAILER',
    key: 'TESTVIDEO123',
    site: 'YouTube',
    type: 'Trailer',
    official: true,
    publishedAt: '2021-07-02T21:00:00.000Z',
    url: 'https://www.youtube.com/watch?v=TESTVIDEO123',
    updatedAt: new Date(),
    viewCount: 0,
  });

  logs.length = 0;
  await Movie.deleteMany({ slug: MOVIE.slug });
  const res = await MovieService.saveMovie(MOVIE, 'test-youtube-only', false);
  const db2 = await Movie.findOne({ slug: MOVIE.slug }).lean();

  check('Movie được tạo', !!db2 && db2.name === MOVIE.name);
  check('Movie.trailer là OBJECT có key', !!(db2.trailer && db2.trailer.key),
    JSON.stringify(db2.trailer));
  check('trailer.key = TESTVIDEO123', db2.trailer?.key === 'TESTVIDEO123');
  check('trailer.site = YouTube', db2.trailer?.site === 'YouTube');
  check('trailer.type = Trailer', db2.trailer?.type === 'Trailer');
  check('trailer.official = true', db2.trailer?.official === true);
  check('trailer có publishedAt', !!db2.trailer?.publishedAt);
  check('trailer.url đúng format',
    db2.trailer?.url === 'https://www.youtube.com/watch?v=TESTVIDEO123');
  check('trailer có updatedAt', !!db2.trailer?.updatedAt);
  check('trailerJobStatus = OK', db2.trailerJobStatus === 'OK');
  check('Log "✅ YouTube trailer found: TESTVIDEO123"',
    allLogs().includes('✅ YouTube trailer found: TESTVIDEO123'));
  check('Log "💾 Trailer saved to Movie"',
    allLogs().includes('💾 Trailer saved to Movie'));

  const iFound = allLogs().indexOf('YouTube trailer found');
  const iSaved = allLogs().indexOf('Trailer saved to Movie');
  const iCreated = allLogs().search(/Created movie|Updated movie/);
  check('Thứ tự log: found → saved → Created movie',
    iFound < iSaved && iSaved < iCreated,
    `found=${iFound}, saved=${iSaved}, created=${iCreated}`);
  check('Log "Created movie" chứa Trailer: ✅',
    /Created movie.*Trailer: ✅/.test(allLogs()));

  // ═══════════════════════════════════════════════════════════════
  console.log('');
  console.log('═'.repeat(74));
  console.log('G. FORBIDDEN LOGS (#8)');
  console.log('═'.repeat(74));
  check('KHÔNG log "trying TMDB fallback source"',
    !allLogs().includes('trying TMDB fallback source'));
  check('KHÔNG log "tmdb=SKIPPED"', !allLogs().includes('tmdb=SKIPPED'));
  check('KHÔNG log "Trailer untouched"', !allLogs().includes('Trailer untouched'));
  check('KHÔNG log "TMDB fallback success"', !allLogs().includes('TMDB fallback success'));
  check('KHÔNG log "ERROR resolving trailer"', !allLogs().includes('ERROR resolving trailer'));
  console.log('');

  YouTubeService.searchTrailer = origSearch;

  console.log('═'.repeat(74));
  console.log(`📊 KẾT QUẢ: ${GREEN}${pass} passed${RESET}, ${fail ? RED + fail + ' failed' + RESET : '0 failed'}`);
  console.log('═'.repeat(74));

  // In log thực tế
  console.log('');
  console.log('  ── Log thực tế (phim, phần Happy Path) ──');
  logs.filter((l) => /Trailer|Created movie|Updated movie/.test(l))
    .forEach((l) => console.log('   ' + l.slice(0, 120)));
  console.log('');

  await Movie.deleteMany({ slug: MOVIE.slug });
  trailerState.reset();
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`${RED}❌ Fatal:${RESET}`, e.message);
  console.error(e.stack);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
