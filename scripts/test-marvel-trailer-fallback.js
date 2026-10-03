/**
 * Test: YouTube lỗi (429 / CIRCUIT_OPEN) → trailer = null, retry later
 *
 * Kịch bản test hệ thống mới (YouTube-only):
 *   1. Ép YouTube circuit OPEN (mô phỏng 429 liên tiếp)
 *   2. Gọi TrailerService.getTrailer() cho 2 phim
 *   3. Xác nhận:
 *      - Movie.trailer = null (KHÔNG có fallback nào khác)
 *      - trailerJobStatus = RATE_LIMITED
 *      - trailerRetryAt được set
 *      - KHÔNG có log "Trailer untouched" / "TMDB fallback success" / "trying TMDB"
 *      - Có log "⚠️ YouTube unavailable → trailer=null, retry later"
 *
 * ⭐ TMDB đã bị gỡ khỏi flow trailer. YouTube là nguồn DUY NHẤT.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO =
  process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/XomPhim';

const MOVIES = [
  {
    name: 'Những chủ nhân vũ trụ: Khải huyền (Phần 1)',
    originName: 'Masters of the Universe: Revelation',
    slug: 'nhung-chu-nhan-vu-tru-khai-huyen-phan-1',
    releaseDate: new Date('2021-07-23'),
  },
  {
    name: 'Những chủ nhân vũ trụ: Khải huyền (Phần 2)',
    originName: 'Masters of the Universe: Revelation',
    slug: 'nhung-chu-nhan-vu-tru-khai-huyen-phan-2',
    releaseDate: new Date('2021-07-23'),
  },
  {
    // Ca test: YouTube circuit OPEN → trailer phải = null, retryAt set.
    name: 'Những chủ nhân vũ trụ: Khải huyền (YouTube circuit OPEN)',
    originName: 'Masters of the Universe: Revelation',
    slug: 'nhung-chu-nhan-vu-tru-khai-huyen-circuit-open',
    releaseDate: new Date('2021-07-23'),
    expectNoTrailer: true,
  },
];

const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

async function main() {
  const TrailerService = require('../src/services/TrailerService');
  const YouTubeService = require('../src/services/YouTubeService');
  const rateLimiter = require('../src/utils/youtubeRateLimiter');
  const trailerState = require('../src/utils/trailerState');
  const { Movie } = require('../src/models');

  await mongoose.connect(MONGO);
  console.log(`${GREEN}✅ Connected to MongoDB${RESET} (${MONGO})\n`);

  // ── Capture log output để kiểm tra message bắt buộc ──
  const logs = [];
  const logger = require('../src/utils/logger');
  const origInfo = logger.info.bind(logger);
  const origWarn = logger.warn.bind(logger);
  logger.info = (...a) => { logs.push(a.join(' ')); origInfo(...a); };
  logger.warn = (...a) => { logs.push(a.join(' ')); origWarn(...a); };

  console.log('=== CONFIG ===');
  console.log('  YouTube enabled :', YouTubeService.enabled);
  console.log('  YouTube isAvailable :', YouTubeService.isAvailable());
  console.log('');

  // ─────────────────────────────────────────────────────────────
  // 1. Mô phỏng YouTube 429 → circuit OPEN
  // ─────────────────────────────────────────────────────────────
  console.log('=== SIMULATE YOUTUBE 429 ===');
  for (let i = 0; i < 4; i++) rateLimiter.recordFailure({ status: 429, retryAfterMs: 60000 });
  console.log('  circuit state :', rateLimiter.cb.state);
  console.log('  isCircuitOpen :', rateLimiter.isCircuitOpen());
  console.log('  isAvailable   :', YouTubeService.isAvailable());
  console.log('');

  // ─────────────────────────────────────────────────────────────
  // 2. Seed movies với trailer = null
  // ─────────────────────────────────────────────────────────────
  const ids = [];
  for (const spec of MOVIES) {
    const doc = await Movie.findOneAndUpdate(
      { slug: spec.slug },
      {
        $set: {
          name: spec.name,
          originName: spec.originName,
          source: 'test-trailer-fallback',
          sourceId: spec.slug,
          releaseDate: spec.releaseDate,
          type: 'series',
          status: 'completed',
          isPublished: true,
          isHidden: false,
          episodes: [],
          trailer: null,
          trailerJobStatus: 'OK',
          trailerRetryAt: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    ids.push(doc._id);
    console.log(`  Seeded: ${spec.name} (_id=${doc._id}, trailer=null)`);
  }
  console.log('');

  // ─────────────────────────────────────────────────────────────
  // 3. Chạy TrailerService cho từng movie
  // ─────────────────────────────────────────────────────────────
  const results = [];
  for (const spec of MOVIES) {
    const doc = await Movie.findOne({ slug: spec.slug }).lean();
    console.log('='.repeat(72));
    console.log(`🎬 ${spec.name}`);
    console.log('='.repeat(72));
    console.log('  trailer(before):', JSON.stringify(doc.trailer));
    console.log('');

    const result = await TrailerService.getTrailer(doc, { force: true });

    console.log('');
    console.log('  ── RESULT ──');
    console.log('  status :', result.status);
    console.log('  source :', result.source);
    console.log('  saved  :', result.saved);
    if (result.retryAt) console.log('  retryAt:', result.retryAt.toISOString());
    console.log('');

    const after = await Movie.findOne({ _id: doc._id }).lean();
    console.log('  ── MONGODB AFTER ──');
    console.log('  trailer:', JSON.stringify(after.trailer, null, 2));
    console.log('  trailerJobStatus:', after.trailerJobStatus);
    console.log('  trailerRetryAt:', after.trailerRetryAt);
    console.log('');

    const hasTrailer = !!(after.trailer && after.trailer.key);
    const isRateLimited = after.trailerJobStatus === 'RATE_LIMITED';
    const hasRetryAt = !!after.trailerRetryAt;

    // Kỳ vọng mới: Khi YouTube circuit OPEN → trailer = null + RATE_LIMITED + retryAt
    const ok = spec.expectNoTrailer
      ? (!hasTrailer && isRateLimited && hasRetryAt)
      : (hasTrailer || (isRateLimited && hasRetryAt));

    if (ok) {
      console.log(
        spec.expectNoTrailer
          ? `  ${GREEN}✅ PASS${RESET}: trailer=null, RATE_LIMITED, retryAt set (YouTube circuit OPEN)`
          : `  ${GREEN}✅ PASS${RESET}: Trailer xử lý đúng (status=${result.status})`
      );
    } else {
      console.log(
        `  ${RED}❌ FAIL${RESET}: trailer=${JSON.stringify(after.trailer)}, status=${after.trailerJobStatus}`
      );
    }
    console.log('');

    results.push({ ...spec, status: result.status, source: result.source, trailer: after.trailer, jobStatus: after.trailerJobStatus });
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Kiểm tra log bắt buộc / log cấm
  // ─────────────────────────────────────────────────────────────
  console.log('='.repeat(72));
  console.log('📋 LOG ASSERTIONS');
  console.log('='.repeat(72));
  const allLogs = logs.join('\n');

  const hasYouTubeUnavailable = allLogs.includes('YouTube unavailable → trailer=null, retry later');
  const hasNoTrailerFound = allLogs.includes('No trailer found');
  const hasBadErrorLog = allLogs.includes('ERROR resolving trailer');
  const hasUntouched = allLogs.includes('Trailer untouched');
  const hasFallbackSuccess = allLogs.includes('TMDB fallback success');
  const hasTryingTMDB = allLogs.includes('trying TMDB fallback source');

  console.log(`  [Trailer] ⚠️ YouTube unavailable → trailer=null, retry later: ${hasYouTubeUnavailable ? GREEN + 'YES (good)' + RESET : RED + 'NO (bad)' + RESET}`);
  console.log(`  [Trailer] ⚠️ No trailer found         : ${hasNoTrailerFound ? GREEN + 'YES' + RESET : RED + 'NO' + RESET}`);
  console.log(`  ❌ KHÔNG được có log "ERROR resolving trailer"   : ${hasBadErrorLog ? RED + 'YES (BAD)' + RESET : GREEN + 'NO (good)' + RESET}`);
  console.log(`  ❌ KHÔNG được có log "Trailer untouched"          : ${hasUntouched ? RED + 'YES (BAD)' + RESET : GREEN + 'NO (good)' + RESET}`);
  console.log(`  ❌ KHÔNG được có log "TMDB fallback success"      : ${hasFallbackSuccess ? RED + 'YES (BAD)' + RESET : GREEN + 'NO (good)' + RESET}`);
  console.log(`  ❌ KHÔNG được có log "trying TMDB fallback source": ${hasTryingTMDB ? RED + 'YES (BAD)' + RESET : GREEN + 'NO (good)' + RESET}`);
  console.log('');

  // ─────────────────────────────────────────────────────────────
  // 5. Summary
  // ─────────────────────────────────────────────────────────────
  console.log('='.repeat(72));
  console.log('📊 SUMMARY');
  console.log('='.repeat(72));
  let pass = 0;
  for (const r of results) {
    const hasTrailer = !!(r.trailer && r.trailer.key);
    const rateLimited = r.jobStatus === 'RATE_LIMITED';
    const testOk = r.expectNoTrailer
      ? (!hasTrailer && rateLimited)
      : (hasTrailer || rateLimited);
    if (testOk) pass++;
    console.log(`  ${testOk ? GREEN + '✅' : RED + '❌'}${RESET} ${r.name} (status=${r.status}, jobStatus=${r.jobStatus})`);
  }
  console.log('');
  console.log(`  ${pass}/${results.length} movie tests passed`);
  console.log('');

  // Cleanup
  for (const id of ids) {
    await Movie.deleteOne({ _id: id });
  }
  console.log('  (cleanup done)');

  // Reset state
  rateLimiter.cb.state = 'CLOSED';
  rateLimiter.cb.failureCount = 0;
  rateLimiter.globalCooldownUntil = 0;
  trailerState.reset();

  await mongoose.disconnect();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`${RED}❌ Fatal:${RESET}`, e.message);
  console.error(e.stack);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
