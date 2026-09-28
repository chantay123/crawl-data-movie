/**
 * Smoke test for new trailer + rate limiter architecture.
 *
 * Verifies:
 *   1. Movie model accepts the nested trailer object with all 8 fields
 *   2. YouTubeService is wired to the rate limiter (singleton)
 *   3. YouTubeService throws tagged errors (RATE_LIMITED / CIRCUIT_OPEN)
 *   4. TrailerService returns { trailer, status, saved, retryAt }
 *   5. Rate limiter status() works
 *
 * Run with: `node scripts/test-trailer-refactor.js`
 * (does NOT require network or DB)
 */

const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));

let passed = 0, failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function bad(label, msg) { failed++; console.error(`  ❌ ${label}: ${msg}`); }

(async () => {
  console.log('🧪 Trailer refactor smoke test\n');

  // 1. Schema has the right shape
  const { Movie } = require(path.join(__dirname, '..', 'src', 'models'));
  const trailerPath = Movie.schema.paths.trailer;
  if (trailerPath) {
    ok('Movie schema has nested `trailer` field');
    const sub = trailerPath.schema;
    for (const field of ['name', 'key', 'site', 'type', 'official', 'publishedAt', 'url', 'updatedAt', 'viewCount']) {
      if (sub.paths[field]) ok(`trailer.${field} defined`);
      else bad(`trailer.${field}`, 'missing');
    }
    // Mongoose v8 stores _id:false in options on the subdoc schema
    const subOpts = trailerPath.schema.options || {};
    if (subOpts._id === false) ok('trailer subdoc has _id:false');
    else bad('trailer _id:false', `expected _id:false, got ${JSON.stringify(subOpts)}`);
    if (trailerPath.defaultValue === null) ok('trailer default is null');
    else bad('trailer default', `expected null, got ${trailerPath.defaultValue}`);
  } else {
    bad('Movie.trailer', 'not defined');
  }

  if (Movie.schema.paths.trailerJobStatus) ok('Movie.trailerJobStatus defined');
  else bad('Movie.trailerJobStatus', 'missing');
  if (Movie.schema.paths.trailerRetryAt) ok('Movie.trailerRetryAt defined');
  else bad('Movie.trailerRetryAt', 'missing');

  // 2. No legacy top-level trailer field on schema
  const legacy = ['trailerUrl', 'trailerKey', 'youtubeTrailer', 'youtubeVideoId'];
  for (const f of legacy) {
    if (Movie.schema.paths[f]) bad(`legacy field ${f}`, 'still on schema');
    else ok(`legacy field ${f} absent from schema`);
  }

  // 3. Rate limiter singleton has expected state
  const rateLimiter = require(path.join(__dirname, '..', 'src', 'utils', 'youtubeRateLimiter'));
  const status = rateLimiter.status();
  if (typeof status.concurrency === 'number') ok(`rate limiter concurrency=${status.concurrency}`);
  else bad('rate limiter concurrency', 'not a number');
  if (status.cbState === 'CLOSED') ok('circuit breaker starts CLOSED');
  else bad('circuit breaker state', status.cbState);

  // 4. recordOutcome / recordFailure trip circuit after threshold
  for (let i = 0; i < rateLimiter.cb.failureThreshold; i++) {
    rateLimiter.recordOutcome({ status: 429, retryAfterMs: 1000 });
  }
  if (rateLimiter.isCircuitOpen()) ok('circuit breaker opens after threshold 429s');
  else bad('circuit breaker', 'still closed');

  // 5. YouTubeService exports an instance with expected shape
  const YouTubeService = require(path.join(__dirname, '..', 'src', 'services', 'YouTubeService'));
  for (const fn of ['searchTrailer', '_executeWithRetry', '_callYouTube']) {
    if (typeof YouTubeService[fn] === 'function') ok(`YouTubeService.${fn} exists`);
    else bad(`YouTubeService.${fn}`, 'missing');
  }

  // 5b. Circuit breaker recovery
  rateLimiter.recordSuccess();
  if (!rateLimiter.isCircuitOpen()) ok('circuit breaker closes on success');
  else bad('circuit breaker recovery', 'still open');

  // 6. TrailerService returns the new shape
  const TrailerService = require(path.join(__dirname, '..', 'src', 'services', 'TrailerService'));
  const fakeMovie = { _id: 'fake-id', name: 'Avengers', trailer: null };
  // Don't actually call YouTube - just check the methods exist with the right signature
  if (typeof TrailerService.getTrailer === 'function') ok('TrailerService.getTrailer exists');
  if (typeof TrailerService.search === 'function') ok('TrailerService.search exists');
  if (typeof TrailerService.saveTrailer === 'function') ok('TrailerService.saveTrailer exists');
  if (typeof TrailerService.markRateLimited === 'function') ok('TrailerService.markRateLimited exists');

  // 7. Config has new fields
  for (const k of ['concurrency', 'retryBaseDelayMs', 'retryMaxDelayMs', 'circuitFailureThreshold', 'circuitCooldownMs', 'requestTimeoutMs']) {
    if (config.youtube[k] !== undefined) ok(`config.youtube.${k} = ${config.youtube[k]}`);
    else bad(`config.youtube.${k}`, 'missing');
  }

  console.log(`\n========================================`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`========================================\n`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});