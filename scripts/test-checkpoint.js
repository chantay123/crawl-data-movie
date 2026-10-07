/**
 * Test tích hợp CHECKPOINT cho trailer crawler.
 *
 * Scenario:
 *   1. Run batch với jobId='test-job', mock QUOTA_EXCEEDED tại movie thứ 3 (index 2).
 *   2. Verify checkpoint được lưu với status=QUOTA_EXCEEDED, currentIndex=2.
 *   3. Run lại batch (resume) — verify bắt đầu từ index 2.
 *   4. Cleanup.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TrailerService = require('../src/services/TrailerService');
const trailerCheckpoint = require('../src/utils/trailerCheckpoint');
const logger = require('../src/utils/logger');
const { Movie, TrailerCrawlerCheckpoint } = require('../src/models');

const TEST_JOB_ID = 'test-checkpoint-' + Date.now();

function logSection(title) {
  console.log('\n' + '='.repeat(70));
  console.log('  ' + title);
  console.log('='.repeat(70));
}

async function setupTestMovies() {
  // Tạo 10 test movies
  const movies = [];
  for (let i = 0; i < 10; i++) {
    movies.push({
      _id: new mongoose.Types.ObjectId(),
      name: `Test Movie ${i + 1}`,
      slug: `test-movie-${TEST_JOB_ID}-${i + 1}`,
      originName: `Test Movie ${i + 1} Origin`,
      releaseDate: new Date('2024-01-01'),
      trailer: null,
      trailerJobStatus: null,
      trailerRetryAt: null,
      dateLastMain: new Date(),
    });
  }
  await Movie.insertMany(movies);
  return movies;
}

async function cleanupTestMovies(movies) {
  await Movie.deleteMany({ _id: { $in: movies.map(m => m._id) } });
  await TrailerCrawlerCheckpoint.deleteOne({ jobId: TEST_JOB_ID });
}

async function showCheckpoint() {
  const cp = await TrailerCrawlerCheckpoint.findOne({ jobId: TEST_JOB_ID }).lean();
  console.log(`  status              : ${cp?.status || '(none)'}`);
  console.log(`  currentMovieId      : ${cp?.currentMovieId || '(null)'}`);
  console.log(`  currentIndex        : ${cp?.currentIndex}`);
  console.log(`  totalMovies         : ${cp?.totalMovies}`);
  console.log(`  lastProcessedIndex  : ${cp?.lastProcessedIndex}`);
  console.log(`  quotaExceededAt     : ${cp?.quotaExceededAt ? cp.quotaExceededAt.toISOString() : '(null)'}`);
  console.log(`  resumeAt            : ${cp?.resumeAt ? cp.resumeAt.toISOString() : '(null)'}`);
  console.log(`  updatedAt           : ${cp?.updatedAt ? cp.updatedAt.toISOString() : '(null)'}`);
  if (cp?.stats) {
    console.log(`  stats               : found=${cp.stats.found}, notFound=${cp.stats.notFound}, ` +
                `skipped=${cp.stats.skipped}`);
  }
}

async function runTest() {
  let testMovies = [];
  try {
    logSection('CONNECT');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    logSection('Setup: tạo 10 test movies');
    testMovies = await setupTestMovies();
    console.log(`✅ Created ${testMovies.length} test movies`);
    console.log(`  jobId = ${TEST_JOB_ID}`);

    // ============================================
    // TEST 1: Mock QUOTA_EXCEEDED tại movie index 2
    // ============================================
    logSection('TEST 1: Run batch với mock QUOTA_EXCEEDED ở movie thứ 3 (index=2)');

    let callCount = 0;
    const originalGetTrailer = TrailerService.prototype.getTrailer;
    TrailerService.prototype.getTrailer = async function(movie) {
      callCount++;
      console.log(`  [mock] getTrailer called for movie ${callCount}: "${movie.name}" (index=${callCount - 1})`);
      if (callCount === 3) {
        // Movie thứ 3 (index=2) trả về QUOTA_EXCEEDED
        return {
          trailer: null,
          status: 'RATE_LIMITED',
          code: 'QUOTA_EXCEEDED',
          retryAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h sau
          error: null,
          source: null,
        };
      }
      // Movies khác: thành công với trailer giả
      return {
        trailer: { key: 'dQw4w9WgXcQ', url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' },
        status: 'FOUND',
        retryAt: null,
        error: null,
        source: 'youtube',
      };
    };

    // Mock Movie.find để trả về test movies thay vì query DB
    const originalMovieFind = Movie.find;
    const originalMovieCount = Movie.countDocuments;
    Movie.find = function() {
      const chain = {
        select: () => chain,
        sort: () => chain,
        limit: () => chain,
        lean: async () => testMovies,
      };
      return chain;
    };
    Movie.countDocuments = async () => testMovies.length;

    // Mock Movie.updateOne để không ghi vào DB thật
    const originalMovieUpdateOne = Movie.updateOne;
    Movie.updateOne = async () => ({ acknowledged: true });

    console.log('  ▶ Starting batch (sẽ dừng tại movie 3)...');
    const stats1 = await TrailerService.batchUpdateTrailers({
      batchSize: 10,
      jobId: TEST_JOB_ID,
      limit: 100,
    });
    console.log('  ✅ Run 1 stats:', JSON.stringify(stats1, null, 2));

    logSection('CHECKPOINT sau TEST 1');
    await showCheckpoint();

    // Verify
    const cp1 = await TrailerCrawlerCheckpoint.findOne({ jobId: TEST_JOB_ID }).lean();
    if (cp1.status === 'QUOTA_EXCEEDED' && cp1.currentIndex === 2) {
      console.log('  ✅ PASS: status=QUOTA_EXCEEDED, currentIndex=2');
    } else {
      console.log(`  ❌ FAIL: expected status=QUOTA_EXCEEDED, currentIndex=2. Got status=${cp1.status}, currentIndex=${cp1.currentIndex}`);
    }

    // ============================================
    // TEST 2: Resume từ checkpoint
    // ============================================
    logSection('TEST 2: Resume — verify bắt đầu từ movie index 2');

    callCount = 0;
    console.log('  ▶ Starting batch (resume)...');
    const stats2 = await TrailerService.batchUpdateTrailers({
      batchSize: 10,
      jobId: TEST_JOB_ID,
      limit: 100,
    });
    console.log('  ✅ Run 2 stats:', JSON.stringify(stats2, null, 2));

    logSection('CHECKPOINT sau TEST 2');
    await showCheckpoint();

    const cp2 = await TrailerCrawlerCheckpoint.findOne({ jobId: TEST_JOB_ID }).lean();
    if (cp2.status === 'COMPLETED' && cp2.currentIndex === 10) {
      console.log('  ✅ PASS: status=COMPLETED, currentIndex=10 (totalMovies)');
    } else {
      console.log(`  ❌ FAIL: expected COMPLETED, currentIndex=10. Got status=${cp2.status}, currentIndex=${cp2.currentIndex}`);
    }

    // ============================================
    // TEST 3: Force restart
    // ============================================
    logSection('TEST 3: --force-restart — verify reset về index 0');

    callCount = 0;
    const stats3 = await TrailerService.batchUpdateTrailers({
      batchSize: 10,
      jobId: TEST_JOB_ID,
      limit: 100,
      forceRestart: true,
    });
    console.log('  ✅ Run 3 stats:', JSON.stringify(stats3, null, 2));

    const cp3 = await TrailerCrawlerCheckpoint.findOne({ jobId: TEST_JOB_ID }).lean();
    if (cp3.status === 'COMPLETED' && cp3.currentIndex === 10 && cp3.currentMovieId === null) {
      console.log('  ✅ PASS: status=COMPLETED, currentIndex=10, currentMovieId=null');
    } else {
      console.log(`  ❌ FAIL: got status=${cp3.status}, currentIndex=${cp3.currentIndex}, currentMovieId=${cp3.currentMovieId}`);
    }

    // ============================================
    // Restore mocks
    // ============================================
    TrailerService.prototype.getTrailer = originalGetTrailer;
    Movie.find = originalMovieFind;
    Movie.countDocuments = originalMovieCount;
    Movie.updateOne = originalMovieUpdateOne;

  } catch (err) {
    console.error('❌ Error:', err);
    console.error(err.stack);
  } finally {
    logSection('CLEANUP');
    await cleanupTestMovies(testMovies);
    console.log(`  ✅ Cleaned up ${testMovies.length} test movies + checkpoint`);
    await mongoose.disconnect();
    console.log('  ✅ Disconnected');
  }
}

runTest().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});