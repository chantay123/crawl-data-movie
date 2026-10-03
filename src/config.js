require('dotenv').config();

const toBool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  return String(v).toLowerCase() === 'true';
};

const toInt = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

module.exports = {
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/movie_crawler',
    name: process.env.MONGODB_NAME || 'XomPhim',
  },
  crawler: {
    totalPages: toInt(process.env.TOTAL_PAGES, 3337),
    pageDelayMs: toInt(process.env.PAGE_DELAY_MS, 500),
    detailConcurrency: toInt(process.env.DETAIL_CONCURRENCY, 5),
    maxEmptyPages: toInt(process.env.MAX_EMPTY_PAGES, 2),
  },
  sources: {
    ophim: {
      enabled: toBool(process.env.ENABLE_OPHIM, true),
      baseUrl: process.env.OPHIM_BASE_URL || 'https://ophim1.com/v1/api',
    },
    kkphim: {
      enabled: toBool(process.env.ENABLE_KKPHIM, true),
      baseUrl: process.env.KKPHIM_BASE_URL || 'https://kkphim.com/api',
    },
    nguonc: {
      enabled: toBool(process.env.ENABLE_NGUONC, true),
      baseUrl: process.env.NGUONC_BASE_URL || 'https://nguonc.com/api',
    },
  },
  output: {
    jsonBackup: toBool(process.env.JSON_BACKUP, true),
    jsonDir: process.env.JSON_OUTPUT_DIR || './data',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
  
  // TMDB API configuration
  tmdb: {
    apiKey: process.env.TMDB_API_KEY || '',
    baseUrl: process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3',
    enabled: toBool(process.env.ENABLE_TMDB_ENRICHMENT, false),
    requestDelay: toInt(process.env.TMDB_REQUEST_DELAY, 350),
    maxRetries: toInt(process.env.TMDB_MAX_RETRIES, 3),
  },
  
  // YouTube API configuration
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || '',
    enabled: toBool(process.env.ENABLE_YOUTUBE_TRAILER, false),
    requestDelay: toInt(process.env.YOUTUBE_REQUEST_DELAY, 5000),
    maxResults: toInt(process.env.YOUTUBE_MAX_RESULTS, 5),
    // Retry config for 429/5xx
    maxRetries: toInt(process.env.YOUTUBE_MAX_RETRIES, 3),
    baseRetryDelay: toInt(process.env.YOUTUBE_BASE_RETRY_DELAY, 2000),
    retryBackoffMultiplier: toInt(process.env.YOUTUBE_RETRY_BACKOFF_MULTIPLIER, 2),
    maxRetryAfter: toInt(process.env.YOUTUBE_MAX_RETRY_AFTER, 60000),
    // NEW: Hardened rate limiter / circuit breaker config
    concurrency: toInt(process.env.YOUTUBE_CONCURRENCY, 1),
    retryBaseDelayMs: toInt(process.env.YOUTUBE_RETRY_BASE_DELAY_MS, 30000),
    retryMaxDelayMs: toInt(process.env.YOUTUBE_RETRY_MAX_DELAY_MS, 3600000),
    circuitFailureThreshold: toInt(process.env.YOUTUBE_CIRCUIT_FAILURE_THRESHOLD, 3),
    circuitCooldownMs: toInt(process.env.YOUTUBE_CIRCUIT_COOLDOWN_MS, 900000),
    requestTimeoutMs: toInt(process.env.YOUTUBE_REQUEST_TIMEOUT_MS, 10000),
  },
  
  // Wikipedia API configuration (không cần API key)
  wikipedia: {
    enabled: toBool(process.env.ENABLE_WIKIPEDIA_ENRICHMENT, true),
    lang: process.env.WIKIPEDIA_LANG || 'en', // 'en' hoặc 'vi'
    requestDelay: toInt(process.env.WIKIPEDIA_REQUEST_DELAY, 300),
    fallbackToWikiOnTMDBFail: toBool(process.env.WIKIPEDIA_FALLBACK_ON_TMDB_FAIL, true),
  },

  // Wikidata API configuration (không cần API key)
  wikidata: {
    enabled: toBool(process.env.ENABLE_WIKIDATA_ENRICHMENT, true),
    // KHÔNG hard-code trong source — đọc từ env WIKIDATA_API_URL
    apiUrl: process.env.WIKIDATA_API_URL || 'https://www.wikidata.org/w/api.php',
    // Wikidata anon rate limit ≈ 1 req/s. Default 1100ms (an toàn + chừa margin).
    // Nếu bạn có bot account / User-Agent đã đăng ký, có thể giảm xuống 250-500.
    requestDelay: toInt(process.env.WIKIDATA_REQUEST_DELAY, 1100),
    timeoutMs: toInt(process.env.WIKIDATA_TIMEOUT_MS, 10000),
    maxRetries: toInt(process.env.WIKIDATA_MAX_RETRIES, 4),
    lang: process.env.WIKIDATA_LANG || 'en',
    userAgent: process.env.WIKIDATA_USER_AGENT || 'MovieStreaming/1.0 (https://github.com/your-repo; contact: your-email@example.com)',
    // Cache config — KHÔNG cache transient errors (RATE_LIMITED / SERVER_ERROR / NETWORK_ERROR)
    cacheEnabled: toBool(process.env.WIKIDATA_CACHE_ENABLED, true),
    cacheTtlMs: toInt(process.env.WIKIDATA_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
    cacheMaxEntries: toInt(process.env.WIKIDATA_CACHE_MAX_ENTRIES, 5000),
    // Pause config — khi gặp 429, queue pause tối thiểu minPauseMs (an toàn ~60s).
    // Mỗi lần gặp 429 tiếp theo trong cùng "burst", pause sẽ tăng theo cấp số nhân
    // (escalate) cho tới khi hết cơn rate-limit.
    minPauseMs: toInt(process.env.WIKIDATA_MIN_PAUSE_MS, 60000),
    maxPauseMs: toInt(process.env.WIKIDATA_MAX_PAUSE_MS, 10 * 60 * 1000),
    // Retry delays (ms) cho 429 / 5xx / network. Mặc định 30s → 60s → 120s → 240s.
    retryDelays: (process.env.WIKIDATA_RETRY_DELAYS || '30000,60000,120000,240000')
      .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite),
    concurrency: toInt(process.env.WIKIDATA_CONCURRENCY, 1),
  },
};
