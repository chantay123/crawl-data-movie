const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save crawl results to JSON
 * Supports two modes:
 * 1. Summary mode (default): saves only statistics and slugs
 * 2. Full mode: saves complete movie data
 */
function save(sourceName, payload) {
  if (!config.output.jsonBackup) return null;
  ensureDir(config.output.jsonDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${sourceName}-${ts}.json`;
  const filepath = path.join(config.output.jsonDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8');
  logger.info(`📁 Saved backup: ${filepath}`);
  return filepath;
}

/**
 * Save full movie data to JSON (for standalone mode)
 * @param {string} sourceName - Source name (ophim, kkphim, nguonc)
 * @param {Array} movies - Array of complete movie objects
 */
function saveFullData(sourceName, movies) {
  if (!config.output.jsonBackup) return null;
  ensureDir(config.output.jsonDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${sourceName}-full-${ts}.json`;
  const filepath = path.join(config.output.jsonDir, filename);
  
  const payload = {
    source: sourceName,
    timestamp: new Date().toISOString(),
    totalMovies: movies.length,
    movies: movies
  };
  
  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8');
  logger.info(`📁 Saved full data: ${filepath} (${movies.length} movies)`);
  return filepath;
}

module.exports = { ensureDir, save, saveFullData };
