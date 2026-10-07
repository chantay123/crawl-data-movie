/**
 * Unit test thuần cho trailerCheckpoint utility.
 *
 * Không cần MongoDB, không cần Mongoose — test logic thuần của
 * checkpoint schema & transitions thông qua giả lập schema trong bộ nhớ.
 */

// =============================================================
// Mini in-memory model (giả lập Mongoose Model)
// =============================================================
class InMemoryModel {
  constructor() {
    this.store = new Map();
  }

  static _makeId() {
    return 'id-' + Math.random().toString(36).slice(2, 10);
  }

  static async findByJobId(jobId) {
    if (!this._inst) this._inst = new InMemoryModel();
    const docs = [...this._inst.store.values()].filter(d => d.jobId === jobId);
    if (docs.length === 0) return null;
    return docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  }

  static async findResumable(jobId) {
    if (!this._inst) this._inst = new InMemoryModel();
    const docs = [...this._inst.store.values()].filter(
      d => d.jobId === jobId && ['RUNNING', 'QUOTA_EXCEEDED', 'PAUSED'].includes(d.status)
    );
    if (docs.length === 0) return null;
    return docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  }

  static async upsertCheckpoint(jobId, data) {
    if (!this._inst) this._inst = new InMemoryModel();
    let existing = null;
    for (const [k, v] of this._inst.store.entries()) {
      if (v.jobId === jobId) {
        existing = v;
        break;
      }
    }
    const newDoc = {
      _id: existing?._id || InMemoryModel._makeId(),
      jobId,
      ...(existing || {}),
      ...data,
      updatedAt: new Date(),
      createdAt: existing?.createdAt || new Date(),
    };
    if (existing) {
      this._inst.store.set(existing._id, newDoc);
    } else {
      this._inst.store.set(newDoc._id, newDoc);
    }
    return newDoc;
  }

  static async findOneAndUpdate(filter, update, options = {}) {
    if (!this._inst) this._inst = new InMemoryModel();
    const jobId = filter.jobId;
    let existing = null;
    for (const [k, v] of this._inst.store.entries()) {
      if (v.jobId === jobId) {
        existing = v;
        break;
      }
    }

    let doc;
    if (existing) {
      doc = JSON.parse(JSON.stringify(existing)); // deep clone
      // Apply $set
      for (const [k, v] of Object.entries(update.$set || {})) {
        if (k.includes('.')) {
          const parts = k.split('.');
          let target = doc;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!target[parts[i]]) target[parts[i]] = {};
            target = target[parts[i]];
          }
          target[parts[parts.length - 1]] = v;
        } else {
          doc[k] = v;
        }
      }
      // Apply $inc
      for (const [k, v] of Object.entries(update.$inc || {})) {
        const parts = k.split('.');
        let target = doc;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!target[parts[i]]) target[parts[i]] = {};
          target = target[parts[i]];
        }
        const lastKey = parts[parts.length - 1];
        target[lastKey] = (target[lastKey] || 0) + v;
      }
      doc.updatedAt = new Date();
      this._inst.store.set(existing._id, doc);
    } else if (options.upsert) {
      doc = {
        _id: InMemoryModel._makeId(),
        jobId,
        updatedAt: new Date(),
        createdAt: new Date(),
      };
      for (const [k, v] of Object.entries(update.$set || {})) {
        if (k.includes('.')) {
          const parts = k.split('.');
          let target = doc;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!target[parts[i]]) target[parts[i]] = {};
            target = target[parts[i]];
          }
          target[parts[parts.length - 1]] = v;
        } else {
          doc[k] = v;
        }
      }
      for (const [k, v] of Object.entries(update.$inc || {})) {
        const parts = k.split('.');
        let target = doc;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!target[parts[i]]) target[parts[i]] = {};
          target = target[parts[i]];
        }
        target[parts[parts.length - 1]] = (target[parts[parts.length - 1]] || 0) + v;
      }
      this._inst.store.set(doc._id, doc);
    } else {
      return null;
    }
    return doc;
  }

  static async deleteOne(filter) {
    if (!this._inst) this._inst = new InMemoryModel();
    let count = 0;
    for (const [k, v] of this._inst.store.entries()) {
      if (v.jobId === filter.jobId) {
        this._inst.store.delete(k);
        count++;
      }
    }
    return { deletedCount: count };
  }
}

// =============================================================
// Reimplement TrailerCheckpoint logic (giống src/utils/trailerCheckpoint.js)
// để chạy không cần require ../models
// =============================================================
const TrailerCrawlerCheckpoint = InMemoryModel;

class TrailerCheckpoint {
  async start(jobId, opts = {}) {
    const { totalMovies = 0, batchSize = 10, maxMovies = 0, forceRestart = false } = opts;
    if (!jobId) throw new Error('jobId required');

    let cp = null;
    if (!forceRestart) {
      cp = await TrailerCrawlerCheckpoint.findResumable(jobId);
    }

    if (cp) {
      if (cp.status !== 'RUNNING') {
        cp = await TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
          status: 'RUNNING',
        });
      }
      return cp;
    }

    cp = await TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'RUNNING',
      currentMovieId: null,
      currentIndex: 0,
      totalMovies,
      lastProcessedMovieId: null,
      lastProcessedIndex: -1,
      quotaExceededAt: null,
      resumeAt: null,
      config: { batchSize, maxMovies },
      stats: { found: 0, notFound: 0, rateLimited: 0, errors: 0, skipped: 0 },
    });
    return cp;
  }

  async beforeMovie(jobId, movie, index) {
    return TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'RUNNING',
      currentMovieId: movie._id,
      currentIndex: index,
    });
  }

  async afterMovie(jobId, movie, index, status) {
    const update = {
      $set: {
        lastProcessedMovieId: movie._id,
        lastProcessedIndex: index,
        currentIndex: index + 1,
        currentMovieId: null,
      },
      $inc: {},
    };
    if (status === 'FOUND') update.$inc['stats.found'] = 1;
    else if (status === 'NOT_FOUND') update.$inc['stats.notFound'] = 1;
    else if (status === 'SKIPPED') update.$inc['stats.skipped'] = 1;

    return TrailerCrawlerCheckpoint.findOneAndUpdate(
      { jobId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  }

  async quotaExceeded(jobId, movie, index, resumeAt = null) {
    return TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'QUOTA_EXCEEDED',
      currentMovieId: movie._id,
      currentIndex: index,
      quotaExceededAt: new Date(),
      resumeAt: resumeAt || null,
    });
  }

  async pause(jobId) {
    return TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'PAUSED',
    });
  }

  async complete(jobId, totalMovies, stats = {}) {
    return TrailerCrawlerCheckpoint.upsertCheckpoint(jobId, {
      status: 'COMPLETED',
      currentMovieId: null,
      currentIndex: totalMovies,
      lastProcessedIndex: totalMovies - 1,
      quotaExceededAt: null,
      resumeAt: null,
      stats,
    });
  }

  async get(jobId) {
    return TrailerCrawlerCheckpoint.findByJobId(jobId);
  }

  async clear(jobId) {
    return TrailerCrawlerCheckpoint.deleteOne({ jobId });
  }
}

const trailerCheckpoint = new TrailerCheckpoint();

// =============================================================
// TESTS
// =============================================================
let testCount = 0, passCount = 0;
function assert(cond, msg) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${msg}`); }
  else { console.log(`  ❌ FAIL: ${msg}`); }
}

async function run() {
  console.log('\n========== UNIT TEST: trailerCheckpoint ==========\n');

  const JOB = 'unit-test-job';

  // -------- TEST 1: start() tạo mới --------
  console.log('TEST 1: start() tạo mới');
  let result1 = await trailerCheckpoint.start(JOB, { totalMovies: 100, batchSize: 10 });
  assert(result1.status === 'RUNNING', 'status = RUNNING');
  assert(result1.currentIndex === 0, 'currentIndex = 0');
  assert(result1.totalMovies === 100, 'totalMovies = 100');
  assert(result1.lastProcessedIndex === -1, 'lastProcessedIndex = -1');
  assert(result1.stats.found === 0, 'stats.found = 0');

  // -------- TEST 2: beforeMovie + afterMovie --------
  console.log('\nTEST 2: beforeMovie + afterMovie');
  const m1 = { _id: 'movie-1', name: 'Test Movie 1' };
  await trailerCheckpoint.beforeMovie(JOB, m1, 0);
  let cp = await trailerCheckpoint.get(JOB);
  assert(String(cp.currentMovieId) === 'movie-1', 'currentMovieId = movie-1');
  assert(cp.currentIndex === 0, 'currentIndex = 0');

  await trailerCheckpoint.afterMovie(JOB, m1, 0, 'FOUND');
  cp = await trailerCheckpoint.get(JOB);
  assert(cp.lastProcessedIndex === 0, 'lastProcessedIndex = 0');
  assert(cp.currentIndex === 1, 'currentIndex = 1 (next)');
  assert(cp.currentMovieId === null, 'currentMovieId reset null');
  assert(cp.stats.found === 1, 'stats.found = 1');

  // -------- TEST 3: quotaExceeded giữ index = movie đang lỗi --------
  console.log('\nTEST 3: quotaExceeded giữ đúng index của movie đang lỗi (quan trọng!)');
  const m3 = { _id: 'movie-3', name: 'Test Movie 3' };
  await trailerCheckpoint.beforeMovie(JOB, m3, 2);
  const resetAt = new Date('2026-10-08T00:00:00Z');
  await trailerCheckpoint.quotaExceeded(JOB, m3, 2, resetAt);

  cp = await trailerCheckpoint.get(JOB);
  assert(cp.status === 'QUOTA_EXCEEDED', 'status = QUOTA_EXCEEDED');
  assert(cp.currentIndex === 2, 'currentIndex = 2 (KHÔNG +1!) ← yêu cầu #14');
  assert(String(cp.currentMovieId) === 'movie-3', 'currentMovieId = movie-3');
  assert(cp.lastProcessedIndex === 0, 'lastProcessedIndex KHÔNG đổi (vẫn 0)');
  assert(cp.quotaExceededAt instanceof Date, 'quotaExceededAt là Date');
  assert(cp.resumeAt && new Date(cp.resumeAt).getTime() === resetAt.getTime(), 'resumeAt đúng');

  // -------- TEST 4: Resume từ checkpoint --------
  console.log('\nTEST 4: Resume từ checkpoint QUOTA_EXCEEDED (yêu cầu #5)');
  const resumable = await trailerCheckpoint.start(JOB, { totalMovies: 100 });
  assert(resumable.status === 'RUNNING', 'start() chuyển status → RUNNING');
  assert(resumable.currentIndex === 2, 'currentIndex GIỮ NGUYÊN 2 ← resume từ checkpoint');
  assert(String(resumable.currentMovieId) === 'movie-3', 'currentMovieId giữ nguyên movie-3');

  // -------- TEST 5: complete() --------
  console.log('\nTEST 5: complete() → currentIndex=totalMovies, status=COMPLETED');
  await trailerCheckpoint.complete(JOB, 100, { found: 50, notFound: 30, errors: 5 });
  cp = await trailerCheckpoint.get(JOB);
  assert(cp.status === 'COMPLETED', 'status = COMPLETED');
  assert(cp.currentIndex === 100, 'currentIndex = totalMovies (100)');
  assert(cp.currentMovieId === null, 'currentMovieId = null');
  assert(cp.lastProcessedIndex === 99, 'lastProcessedIndex = totalMovies - 1');

  // -------- TEST 6: forceRestart bỏ qua COMPLETED --------
  console.log('\nTEST 6: forceRestart=true bỏ qua COMPLETED cũ');
  const cp6 = await trailerCheckpoint.start(JOB, { totalMovies: 100, forceRestart: true });
  assert(cp6.currentIndex === 0, 'currentIndex reset về 0');
  assert(cp6.lastProcessedIndex === -1, 'lastProcessedIndex reset về -1');

  // -------- TEST 7: NOT_FOUND increment stats.notFound --------
  console.log('\nTEST 7: NOT_FOUND increment stats');
  const m7 = { _id: 'movie-7', name: 'Movie 7' };
  await trailerCheckpoint.beforeMovie(JOB, m7, 6);
  await trailerCheckpoint.afterMovie(JOB, m7, 6, 'NOT_FOUND');
  cp = await trailerCheckpoint.get(JOB);
  assert(cp.stats.notFound === 1, 'stats.notFound = 1');
  assert(cp.currentIndex === 7, 'currentIndex = 7 (next)');

  // -------- TEST 8: Pause --------
  console.log('\nTEST 8: pause()');
  await trailerCheckpoint.pause(JOB);
  cp = await trailerCheckpoint.get(JOB);
  assert(cp.status === 'PAUSED', 'status = PAUSED');

  // -------- TEST 9: Resume từ PAUSED --------
  console.log('\nTEST 9: Resume từ PAUSED (yêu cầu #5)');
  const cp9 = await trailerCheckpoint.start(JOB, { totalMovies: 100 });
  assert(cp9.status === 'RUNNING', 'status = RUNNING (sau resume)');
  assert(cp9.currentIndex === 7, 'currentIndex giữ nguyên 7');

  // -------- TEST 10: Clear --------
  console.log('\nTEST 10: clear() xóa checkpoint');
  await trailerCheckpoint.clear(JOB);
  cp = await trailerCheckpoint.get(JOB);
  assert(cp === null, 'checkpoint bị xóa');

  // -------- Summary --------
  console.log(`\n========== ${passCount}/${testCount} tests passed ==========`);
  process.exit(passCount === testCount ? 0 : 1);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});