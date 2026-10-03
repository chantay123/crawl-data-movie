/**
 * Test: Trailer pipeline dedupe / lock / cooldown / circuit breaker (YouTube-only).
 *
 * Mục tiêu — verify các yêu cầu:
 *   1. RATE_LIMITED → không retry movie ngay trong cùng batch
 *   2. Tôn trọng retryAt (now < retryAt → skip)
 *   3. Per-movie in-flight lock (không process đồng thời)
 *   4. YouTube CIRCUIT_OPEN → không gọi lại
 *   5. Rate-limited → không request thêm, giữ trailer=null, lưu retryAt
 *   6. Không overwrite trailer hợp lệ bằng null
 *   7. Không xử lý duplicate cùng movie trong 1 batch
 *
 * Usage: node scripts/test-trailer-dedupe.js
 * (không cần DB — chỉ test in-memory state + guard logic)
 *
 * ⭐ Note: Trailer giờ là YouTube-only. KHÔNG còn TMDB fallback hay searchTMDB().
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.LOG_LEVEL = 'error'; // giảm noise

const mongoose = require('mongoose');
const trailerState = require('../src/utils/trailerState');
const TrailerService = require('../src/services/TrailerService');
const YouTubeService = require('../src/services/YouTubeService');
const rateLimiter = require('../src/utils/youtubeRateLimiter');

let passed = 0, failed = 0;
const ok = (msg) => { passed++; console.log(`  ✅ ${msg}`); };
const bad = (msg) => { failed++; console.log(`  ❌ ${msg}`); };

const oid = () => new mongoose.Types.ObjectId().toString();

/** Tạo movie giả với _id hợp lệ (để tránh CastError khi gọi Movie.updateOne). */
const fakeMovie = (overrides = {}) => ({
  _id: oid(),
  name: 'Test Movie',
  slug: 'test-movie-' + Math.random().toString(36).slice(2),
  trailer: null,
  tmdb: { id: '550' },
  ...overrides,
});

async function main() {
  console.log('\n🧪 Trailer pipeline dedupe test (YouTube-only)\n' + '='.repeat(50));

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 1: Per-movie in-flight lock (req #3)');
  trailerState.reset();
  const m1 = oid();
  if (trailerState.acquire(m1) === true) ok('acquire lần 1 → true');
  else bad('acquire lần 1 phải true');
  if (trailerState.acquire(m1) === false) ok('acquire lần 2 (đồng thời) → false (locked)');
  else bad('acquire lần 2 phải false');
  if (trailerState.acquire(oid()) === true) ok('acquire movie khác → true (không ảnh hưởng)');
  else bad('movie khác phải acquire được');
  trailerState.release(m1);
  if (trailerState.acquire(m1) === true) ok('sau release → acquire lại được');
  else bad('sau release phải acquire được');

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 2: In-flight lock chặn getTrailer chạy song song (req #3)');
  trailerState.reset();
  let searchCalls = 0;
  const origSearch = TrailerService.search.bind(TrailerService);
  TrailerService.search = async () => {
    searchCalls++;
    await new Promise(r => setTimeout(r, 200)); // giả lập network latency
    return { trailer: null, status: 'NOT_FOUND', retryAt: null, error: null, source: null };
  };

  const mLock = fakeMovie({ name: 'Nhu Da Hen' });
  const results = await Promise.all([
    TrailerService.getTrailer(mLock),
    TrailerService.getTrailer(mLock),
    TrailerService.getTrailer(mLock),
  ]);
  const statuses = results.map(r => r.status);
  if (searchCalls === 1) ok(`3 lời gọi đồng thời → chỉ 1 network call (thực tế: ${searchCalls})`);
  else bad(`phải chỉ 1 network call, thực tế: ${searchCalls}`);
  if (statuses.filter(s => s === 'SKIPPED').length === 2) ok(`2 lần còn lại SKIPPED (${statuses.join(', ')})`);
  else bad(`phải có 2 SKIPPED, thực tế: ${statuses.join(', ')}`);

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 3: Dedupe window');
  trailerState.reset();
  const m2 = fakeMovie({ name: 'Dedupe Movie' });
  const r1 = await TrailerService.getTrailer(m2);
  const r2 = await TrailerService.getTrailer(m2); // ngay sau đó
  if (r1.status !== 'SKIPPED' && r2.status === 'SKIPPED') ok('lần 2 trong dedupe window → SKIPPED');
  else bad(`lần 2 phải SKIPPED (r1=${r1.status}, r2=${r2.status})`);
  if (r2.skipReason === undefined || r2.status === 'SKIPPED') ok(`skipReason=${r2.skipReason || 'DEDUPE'}`);

  // Restore ngay sau Test 3 (các test sau cần method thật)
  TrailerService.search = origSearch;

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 4: Tôn trọng retryAt — now < retryAt → skip');
  trailerState.reset();
  // Stub search để đếm số network call
  let cdCalls = 0;
  TrailerService.search = async () => { cdCalls++; return { trailer: null, status: 'NOT_FOUND', retryAt: null, error: null, source: null }; };

  const m3 = fakeMovie({ name: 'Cooldown Movie' });
  const future = new Date(Date.now() + 300000); // +5 phút
  trailerState.setCooldown(m3._id, future, 'RATE_LIMITED');
  const r3 = await TrailerService.getTrailer(m3, { force: true }); // force bỏ dedupe, giữ cooldown
  if (r3.status === 'SKIPPED' && r3.skipReason === 'RATE_LIMITED') ok('now < retryAt → SKIPPED (RATE_LIMITED)');
  else bad(`phải SKIPPED/RATE_LIMITED, thực tế: ${r3.status}/${r3.skipReason}`);
  if (cdCalls === 0) ok('KHÔNG gọi network khi còn trong cooldown');
  else bad('không được gọi network khi còn cooldown');

  // Hết cooldown → phải chạy lại
  trailerState.setCooldown(m3._id, new Date(Date.now() - 1000), 'RATE_LIMITED'); // đã hết hạn
  const r4 = await TrailerService.getTrailer(m3, { force: true });
  if (r4.status !== 'SKIPPED' || r4.skipReason !== 'RATE_LIMITED') ok('now >= retryAt → chạy lại được');
  else bad('khi hết cooldown phải chạy lại');
  if (cdCalls === 1) ok('sau khi hết cooldown mới gọi network (1 call)');
  else bad(`phải gọi 1 network call sau khi hết cooldown, thực tế: ${cdCalls}`);

  // Restore
  TrailerService.search = origSearch;

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 5: YouTube CIRCUIT_OPEN → không gọi lại');
  trailerState.reset();
  rateLimiter.cb.state = 'OPEN';
  rateLimiter.cb.openedAt = Date.now();
  rateLimiter.cb.failureCount = 3;
  if (YouTubeService.isAvailable() === false) ok('YouTube circuit OPEN → isAvailable() = false');
  else bad('circuit OPEN phải isAvailable() = false');
  // Stub _callYouTube để phát hiện nếu YouTubeService bị gọi mạng
  let ytApiCalls = 0;
  const origCallYouTube = YouTubeService._callYouTube.bind(YouTubeService);
  YouTubeService._callYouTube = async () => { ytApiCalls++; throw new Error('should not be called'); };
  const rYt = await TrailerService.search(fakeMovie({ name: 'YT Circuit' }));
  if (rYt.status === 'RATE_LIMITED') ok('search() khi circuit OPEN → RATE_LIMITED ngay (không chờ)');
  else bad(`phải RATE_LIMITED, thực tế: ${rYt.status}`);
  if (ytApiCalls === 0) ok('KHÔNG gọi YouTube API khi circuit OPEN');
  else bad('không được gọi YouTube khi circuit OPEN');
  YouTubeService._callYouTube = origCallYouTube;
  rateLimiter.cb.state = 'CLOSED';
  rateLimiter.cb.failureCount = 0;

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 6: YouTube RATE_LIMITED → trailer=null, retryAt set (req #6)');
  trailerState.reset();
  const mRL = fakeMovie({ name: 'Rate Limited' });
  // YouTube circuit OPEN
  rateLimiter.cb.state = 'OPEN'; rateLimiter.cb.openedAt = Date.now(); rateLimiter.cb.failureCount = 3;
  const rBoth = await TrailerService.getTrailer(mRL);
  if (rBoth.status === 'RATE_LIMITED') ok('YouTube blocked → status RATE_LIMITED');
  else bad(`phải RATE_LIMITED, thực tế: ${rBoth.status}`);
  if (rBoth.retryAt instanceof Date) ok(`retryAt được lưu: ${rBoth.retryAt.toISOString()}`);
  else bad('phải có retryAt');
  if (rBoth.trailer === null) ok('trailer giữ null (không bị set giá trị sai)');
  else bad('trailer phải giữ null');
  // Lần gọi tiếp theo phải SKIP ngay
  const rBoth2 = await TrailerService.getTrailer(mRL, { force: true });
  if (rBoth2.status === 'SKIPPED') ok('lời gọi tiếp theo → SKIP (không retry ngay)');
  else bad(`phải SKIP, thực tế: ${rBoth2.status}`);
  rateLimiter.cb.state = 'CLOSED'; rateLimiter.cb.failureCount = 0;
  trailerState.reset();

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 7: Không overwrite trailer hợp lệ (req #6)');
  trailerState.reset();
  const mExisting = fakeMovie({ name: 'Has Trailer', trailer: { key: 'EXISTING_KEY_123' } });
  const rExist = await TrailerService.getTrailer(mExisting, { force: true });
  if (rExist.status === 'FOUND' && rExist.source === 'existing') ok('movie có trailer → FOUND/existing, không search');
  else bad(`phải FOUND/existing, thực tế: ${rExist.status}/${rExist.source}`);
  if (rExist.trailer?.key === 'EXISTING_KEY_123') ok('trailer.key được giữ nguyên');
  else bad('phải giữ nguyên trailer.key');
  if (rExist.saved === false) ok('saved = false (không ghi đè DB)');
  else bad('không được ghi lại trailer đã có');

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 8: ⭐ KHÔNG còn searchTMDB (YouTube-only)');
  if (typeof TrailerService.searchTMDB === 'undefined') ok('TrailerService.searchTMDB đã bị xoá');
  else bad('TrailerService.searchTMDB phải được xoá (YouTube-only)');
  if (typeof TrailerService.search === 'function') ok('TrailerService.search (YouTube) vẫn còn');
  else bad('TrailerService.search phải tồn tại');

  // ══════════════════════════════════════════════════════════════
  console.log('\n📌 TEST 9: Stats + reset helpers');
  const stats = trailerState.stats();
  if (typeof stats.inFlight === 'number') ok('trailerState.stats() hoạt động (không có trường tmdb)');
  else bad('stats() phải hoạt động');
  if (stats.tmdb === undefined) ok('stats() KHÔNG trả về trường tmdb (đã bỏ)');
  else bad('stats() không được trả về tmdb');
  trailerState.reset();
  if (trailerState.inFlightCount() === 0) ok('reset() xóa toàn bộ state');
  else bad('reset() không hoạt động');

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log('='.repeat(50) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Test crashed:', err); process.exit(1); });
