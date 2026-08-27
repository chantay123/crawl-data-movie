const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function save(sourceName, payload) {
  if (!config.output.jsonBackup) return null;
  ensureDir(config.output.jsonDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${sourceName}-${ts}.json`;
  const filepath = path.join(config.output.jsonDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8');
  return filepath;
}

module.exports = { ensureDir, save };
