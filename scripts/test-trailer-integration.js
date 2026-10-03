/**
 * Integration test: MovieService.saveMovie() với YouTube circuit OPEN
 * → phải tạo Movie + KHÔNG gọi TMDB (đã bỏ), log "Created movie" CHỈ sau khi đã persist.
 *
 * Yêu cầu kiểm chứng: #1, #3, #5, #9
 *
 * Flow mới (YouTube-only):
 *   - YouTube circuit OPEN → trailer = null, trailerJobStatus='RATE_LIMITED',
 *     retryAt set, KHÔNG gọi TMDB, KHÔNG fail movie.
 *   - Nếu YouTube circuit CLOSED → tìm được trailer → lưu vào Movie.triler,
 *     log "✅ YouTube trailer found" + "💾 Trailer saved to Movie" TRƯỚC log "Created movie".
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/XomPhim';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const MOVIE = {
  _id: 'test-marvel-phan-1',
  name: 'Những chủ nhân vũ trụ: Khải huyền (Phần 1)',
  origin_name: 'Masters of the Universe: Revelation',
  slug: 'test-marvel-trailer-phan-1',
  year: 2021,
  type: 'series',
  content: 'Test movie for trailer fallback',
  thumb_url: 'http://x/1.jpg',
  poster_url: 'http://x/1.jpg',
  backdrop_url: 'http://x/1.jpg',
  yearFrom: 2021,
  category: [],
  country: [],
  actor: [],
  director: [],
  episodes: [],
  // tmdb vẫn giữ để test rằng nó KHÔNG còn được dùng cho trailer
  tmdb: { type: 'tv', id: '96658' },
};

async function main() {
  const MovieService = require('../src/services/MovieService');
  const rateLimiter = require('../src/utils/youtubeRateLimiter');
  const trailerState = require('../src/utils/trailerState');
  const YouTubeService = require('../src/services/YouTubeService');
  const { Movie } = require('../src/models');
  const logger = require('../src/utils/logger');

  await mongoose.connect(MONGO);
  console.log(`${GREEN}✅ Connected${RESET} (${MONGO})\n`);

  // Capture logs + vị trí log "Created movie"
  const logs = [];
  let createdLogIndex = -1;
  let createdLogSnapshot = null;
  const oi = logger.info.bind(logger);
  const ow = logger.warn.bind(logger);
  logger.info = (...a) => {
    const msg = a.join(' ');
    logs.push(msg);
    if (msg.includes('Created movie') || msg.includes('Updated movie')) {
      createdLogIndex = logs.length - 1;
      createdLogSnapshot = { msg, at: logs.length };
    }
    oi(...a);
  };
  logger.warn = (...a) => { logs.push(a.join(' ')); ow(...a); };

  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(72));
  console.log('🧪 SCENARIO 1: YouTube circuit OPEN → trailer = null, retryAt set');
  console.log('═'.repeat(72));

  // Mô phỏng YouTube 429 → circuit OPEN
  for (let i = 0; i < 4; i++) rateLimiter.recordFailure({ status: 429, retryAfterMs: 60000 });
  console.log('YouTube circuit OPEN :', rateLimiter.isCircuitOpen());
  console.log('');

  // Dọn sạch trước khi test
  await Movie.deleteMany({ slug: MOVIE.slug });

  const result1 = await MovieService.saveMovie(MOVIE, 'test-trailer', false);

  console.log('  ── RETURNED OBJECT ──');
  console.log('  isNew        :', result1.isNew);
  console.log('  trailerResult:', JSON.stringify({
    status: result1.trailerResult?.status,
    source: result1.trailerResult?.source,
    saved: result1.trailerResult?.saved,
  }));
  console.log('  movie.trailer:', JSON.stringify(result1.movie.trailer, null, 2));
  console.log('');

  const db1 = await Movie.findOne({ slug: MOVIE.slug }).lean();

  console.log('  ── MONGODB ──');
  console.log('  trailer      :', JSON.stringify(db1.trailer, null, 2));
  console.log('  jobStatus    :', db1.trailerJobStatus);
  console.log('  retryAt      :', db1.trailerRetryAt);
  console.log('');

  // Reset circuit
  rateLimiter.cb.state = 'CLOSED';
  rateLimiter.cb.failureCount = 0;
  rateLimiter.globalCooldownUntil = 0;
  trailerState.reset();

  const checks1 = [];
  const add = (name, ok, detail) => checks1.push({ name, ok, detail });

  add('Movie được tạo trong MongoDB',
    !!db1 && db1.name === MOVIE.name,
    `name=${db1?.name}`);
  add('Movie.trailer = null (YouTube circuit OPEN)',
    db1?.trailer === null,
    `trailer=${JSON.stringify(db1?.trailer)}`);
  add('trailerJobStatus = RATE_LIMITED',
    db1?.trailerJobStatus === 'RATE_LIMITED',
    `status=${db1?.trailerJobStatus}`);
  add('trailerRetryAt được set',
    !!db1?.trailerRetryAt,
    `retryAt=${db1?.trailerRetryAt}`);
  add('Log "⚠️ YouTube unavailable → trailer=null, retry later" xuất hiện',
    logs.some((l) => l.includes('YouTube unavailable → trailer=null, retry later')));
  add('KHÔNG log "trying TMDB fallback source"',
    !logs.some((l) => l.includes('trying TMDB fallback source')));
  add('KHÔNG log "TMDB fallback success"',
    !logs.some((l) => l.includes('TMDB fallback success')));
  add('KHÔNG log "Trailer untouched"',
    !logs.some((l) => l.includes('Trailer untouched')));
  add('KHÔNG log "ERROR resolving trailer"',
    !logs.some((l) => l.includes('ERROR resolving trailer')));
  add('Log "Created movie" CÓ "Trailer: ⏸RATE_LIMITED" trong nội dung',
    !!createdLogSnapshot && createdLogSnapshot.msg.includes('Trailer: ⏸RATE_LIMITED'),
    createdLogSnapshot?.msg?.slice(-60) || 'no log');

  console.log('  ── Checks ──');
  let pass1 = 0;
  for (const c of checks1) {
    if (c.ok) pass1++;
    console.log(`  ${c.ok ? GREEN + '✅' : RED + '❌'}${RESET} ${c.name}`);
    if (c.detail) console.log(`       ${c.detail}`);
  }
  console.log(`  ${pass1}/${checks1.length} checks passed`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(72));
  console.log('🧪 SCENARIO 2: YouTube CLOSED + mock trailer → lưu vào MongoDB');
  console.log('═'.repeat(72));

  // Mock YouTube
  const origSearchTrailer = YouTubeService.searchTrailer.bind(YouTubeService);
  YouTubeService.searchTrailer = async () => ({
    name: 'Những chủ nhân vũ trụ: Khải huyền OFFICIAL TRAILER',
    key: 'YT_INTEG_TEST_001',
    site: 'YouTube',
    type: 'Trailer',
    official: true,
    publishedAt: '2021-07-02T21:00:00.000Z',
    url: 'https://www.youtube.com/watch?v=YT_INTEG_TEST_001',
    updatedAt: new Date(),
    viewCount: 0,
  });

  // Reset logs
  logs.length = 0;
  createdLogIndex = -1;
  createdLogSnapshot = null;

  await Movie.deleteMany({ slug: MOVIE.slug });
  const result2 = await MovieService.saveMovie(MOVIE, 'test-trailer', false);
  const db2 = await Movie.findOne({ slug: MOVIE.slug }).lean();

  console.log('  trailer.source:', result2.trailerResult?.source);
  console.log('  trailer.key   :', db2.trailer?.key);
  console.log('');

  const checks2 = [];
  const add2 = (name, ok, detail) => checks2.push({ name, ok, detail });

  add2('Movie.trailer được lưu (OBJECT có key)',
    !!(db2?.trailer && db2.trailer.key),
    `key=${db2?.trailer?.key}`);
  add2('trailer.key = YT_INTEG_TEST_001',
    db2?.trailer?.key === 'YT_INTEG_TEST_001');
  add2('trailer.source = youtube',
    result2.trailerResult?.source === 'youtube',
    `source=${result2.trailerResult?.source}`);
  add2('Log "✅ YouTube trailer found"',
    logs.some((l) => l.includes('YouTube trailer found')));
  add2('Log "💾 Trailer saved to Movie"',
    logs.some((l) => l.includes('Trailer saved to Movie')));
  add2('Log "Created movie" CÓ "Trailer: ✅"',
    !!createdLogSnapshot && createdLogSnapshot.msg.includes('Trailer: ✅'),
    createdLogSnapshot?.msg?.slice(-60) || 'no log');

  // Thứ tự log: found → saved → Created movie
  const iFound = logs.findIndex((l) => l.includes('YouTube trailer found'));
  const iSaved = logs.findIndex((l) => l.includes('Trailer saved to Movie'));
  const iCreated = logs.findIndex((l) => /Created movie|Updated movie/.test(l));
  add2('Thứ tự log: found → saved → Created movie',
    iFound >= 0 && iFound < iSaved && iSaved < iCreated,
    `found=${iFound}, saved=${iSaved}, created=${iCreated}`);

  console.log('  ── Checks ──');
  let pass2 = 0;
  for (const c of checks2) {
    if (c.ok) pass2++;
    console.log(`  ${c.ok ? GREEN + '✅' : RED + '❌'}${RESET} ${c.name}`);
    if (c.detail) console.log(`       ${c.detail}`);
  }
  console.log(`  ${pass2}/${checks2.length} checks passed`);
  console.log('');

  YouTubeService.searchTrailer = origSearchTrailer;
  await Movie.deleteMany({ slug: MOVIE.slug });

  const totalPass = pass1 + pass2;
  const totalChecks = checks1.length + checks2.length;
  console.log('═'.repeat(72));
  console.log(`📋 TỔNG: ${GREEN}${totalPass}/${totalChecks}${RESET} checks passed`);
  console.log('═'.repeat(72));

  await mongoose.disconnect();
  process.exit(totalPass === totalChecks ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`${RED}❌ Fatal:${RESET}`, e.message);
  console.error(e.stack);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
