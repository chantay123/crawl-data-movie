/**
 * Crawler REST API + Swagger UI
 *
 * Endpoints:
 *   GET    /health                  - Health check
 *   GET    /sources                 - Danh sách nguồn + enabled
 *   GET    /movies                  - List phim trong DB (có phân trang)
 *   GET    /movies/:slug            - Chi tiết 1 phim
 *   GET    /movies/stats            - Thống kê theo _source
 *   POST   /crawl/page             - Crawl 1 trang của 1 nguồn (background)
 *   POST   /crawl/all              - Crawl toàn bộ trang của 1 nguồn (background)
 *   GET    /jobs                    - Danh sách job đang chạy / đã chạy
 *
 * Swagger UI: http://localhost:${PORT}/docs
 */

const express = require('express');
const mongoose = require('mongoose');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');
const db = require('./utils/db');
const logger = require('./utils/logger');
const Movie = require('./models/Movie');
const CrawlerService = require('./services/CrawlerService');
const { getEnabledSources, getSource } = require('./services/SourceRegistry');
const openapiSpec = require('./openapi');

const app = express();
app.use(express.json());

// =============================================================
// In-memory job store (đơn giản, không cần Redis cho crawler)
// =============================================================
const jobs = new Map();
let jobSeq = 0;

function createJob(name, source, totalPages) {
  const id = `job_${Date.now()}_${++jobSeq}`;
  const job = {
    id,
    name,
    source,
    status: 'running',
    totalPages,
    currentPage: 0,
    saved: 0,
    updated: 0,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
  return job;
}

// =============================================================
// Routes
// =============================================================

// --- Health ----------------------------------------------------
app.get('/health', async (_req, res) => {
  const dbState = mongoose_state();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mongodb: dbState,
    sources: getEnabledSources().map((s) => s.name()),
  });
});

function mongoose_state() {
  // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  const map = ['disconnected', 'connected', 'connecting', 'disconnected'];
  return {
    status: map[mongoose.connection.readyState] || 'unknown',
    host: mongoose.connection.host || null,
    name: mongoose.connection.name || null,
  };
}

// --- Sources ---------------------------------------------------
app.get('/sources', (_req, res) => {
  const all = ['ophim', 'kkphim', 'nguonc'].map((name) => {
    const cfg = config.sources[name];
    return {
      name,
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
    };
  });
  res.json({ sources: all, enabledCount: all.filter((s) => s.enabled).length });
});

// --- Movies ----------------------------------------------------
app.get('/movies', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const source = req.query.source; // optional: filter theo _source
    const search = req.query.q;

    const filter = {};
    if (source) filter._source = source;
    if (search) filter.name = { $regex: search, $options: 'i' };

    const [items, total] = await Promise.all([
      Movie.find(filter)
        .sort({ _crawledAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('name origin_name slug year thumb_url _source _crawledAt episode_current')
        .lean(),
      Movie.countDocuments(filter),
    ]);

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      items,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/movies/stats', async (_req, res, next) => {
  try {
    const stats = await Movie.aggregate([
      { $group: { _id: '$_source', count: { $sum: 1 } } },
      { $project: { source: '$_id', count: 1, _id: 0 } },
      { $sort: { count: -1 } },
    ]);
    const total = await Movie.countDocuments();
    res.json({ total, bySource: stats });
  } catch (err) {
    next(err);
  }
});

app.get('/movies/:slug', async (req, res, next) => {
  try {
    const movie = await Movie.findOne({ slug: req.params.slug }).lean();
    if (!movie) return res.status(404).json({ error: 'Movie not found', slug: req.params.slug });
    res.json(movie);
  } catch (err) {
    next(err);
  }
});

// --- Crawl trigger ---------------------------------------------
app.post('/crawl/page', async (req, res, next) => {
  try {
    const { source: sourceName, page = 1 } = req.body || {};
    if (!sourceName) return res.status(400).json({ error: 'source is required' });

    let source;
    try {
      source = getSource(sourceName);
    } catch {
      return res.status(400).json({ error: `Unknown source: ${sourceName}` });
    }

    const job = createJob('crawl-page', sourceName, 1);
    res.status(202).json({ jobId: job.id, status: 'queued', message: 'Crawl started in background' });

    // Run async (fire-and-forget)
    runCrawlPage(job, source, page).catch((err) => {
      logger.error(`Job ${job.id} failed: ${err.message}`);
      updateJob(job.id, { status: 'failed', finishedAt: new Date().toISOString() });
    });
  } catch (err) {
    next(err);
  }
});

app.post('/crawl/all', async (req, res, next) => {
  try {
    const { source: sourceName, totalPages } = req.body || {};
    if (!sourceName) return res.status(400).json({ error: 'source is required' });

    let source;
    try {
      source = getSource(sourceName);
    } catch {
      return res.status(400).json({ error: `Unknown source: ${sourceName}` });
    }

    const pages = totalPages || config.crawler.totalPages;
    const job = createJob('crawl-all', sourceName, pages);
    res.status(202).json({ jobId: job.id, status: 'queued', message: `Crawling ${pages} pages in background` });

    runCrawlAll(job, source, pages).catch((err) => {
      logger.error(`Job ${job.id} failed: ${err.message}`);
      updateJob(job.id, { status: 'failed', finishedAt: new Date().toISOString() });
    });
  } catch (err) {
    next(err);
  }
});

// --- Jobs ------------------------------------------------------
app.get('/jobs', (_req, res) => {
  const list = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json({ count: list.length, jobs: list });
});

app.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// --- Swagger UI ------------------------------------------------
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  customSiteTitle: 'Movie Crawler API',
  swaggerOptions: { persistAuthorization: true },
}));

app.get('/openapi.json', (_req, res) => res.json(openapiSpec));

// =============================================================
// Crawl runners (background)
// =============================================================
async function runCrawlPage(job, source, page) {
  const svc = new CrawlerService(source, {
    detailConcurrency: config.crawler.detailConcurrency,
    pageDelayMs: config.crawler.pageDelayMs,
    maxEmptyPages: config.crawler.maxEmptyPages,
  });
  updateJob(job.id, { currentPage: page });
  const result = await svc.crawlPage(page);
  updateJob(job.id, {
    status: 'completed',
    saved: result.savedMovies.length,
    updated: result.updatedMovies.length,
    finishedAt: new Date().toISOString(),
  });
  logger.info(`Job ${job.id} (page) done: +${result.savedMovies.length} new, ~${result.updatedMovies.length} updated`);
}

async function runCrawlAll(job, source, totalPages) {
  const svc = new CrawlerService(source, {
    detailConcurrency: config.crawler.detailConcurrency,
    pageDelayMs: config.crawler.pageDelayMs,
    maxEmptyPages: config.crawler.maxEmptyPages,
  });

  // Progress qua callback onPage → currentPage được cập nhật trên Swagger
  const result = await svc.crawlAllPages(totalPages, (page) =>
    updateJob(job.id, { currentPage: page })
  );

  updateJob(job.id, {
    status: 'completed',
    saved: result.savedMovies.length,
    updated: result.updatedMovies.length,
    errors: result.errors,
    lastPage: result.lastPage,
    finishedAt: new Date().toISOString(),
  });
  logger.info(
    `Job ${job.id} (all) done at page ${result.lastPage}: +${result.savedMovies.length} new, ~${result.updatedMovies.length} updated`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================
// Error handler
// =============================================================
app.use((err, _req, res, _next) => {
  logger.error(`API error: ${err.message}`);
  res.status(500).json({ error: err.message });
});

// =============================================================
// Start
// =============================================================
const PORT = process.env.API_PORT || 3000;

async function start() {
  if (process.env.SKIP_DB !== 'true') {
    try {
      await db.connect();
    } catch (err) {
      logger.warn(`MongoDB unavailable: ${err.message}. API will start but DB endpoints will fail.`);
    }
  }
  app.listen(PORT, () => {
    logger.info(`🚀 Crawler API listening on http://localhost:${PORT}`);
    logger.info(`📚 Swagger UI:  http://localhost:${PORT}/docs`);
    logger.info(`📄 OpenAPI JSON: http://localhost:${PORT}/openapi.json`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  try { await db.disconnect(); } catch {}
  process.exit(0);
});

start();

module.exports = app;