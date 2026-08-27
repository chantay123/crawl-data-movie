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
};
