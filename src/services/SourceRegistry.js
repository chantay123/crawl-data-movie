/**
 * SourceRegistry - Factory tạo Source theo tên
 */

const config = require('../config');
const OPhimSource = require('../sources/OPhimSource');
const KKPhimSource = require('../sources/KKPhimSource');
const NguoncSource = require('../sources/NguoncSource');

const FACTORIES = {
  ophim: (cfg) => new OPhimSource(cfg),
  kkphim: (cfg) => new KKPhimSource(cfg),
  nguonc: (cfg) => new NguoncSource(cfg),
};

function getEnabledSources() {
  const list = [];
  for (const [name, factory] of Object.entries(FACTORIES)) {
    const cfg = config.sources[name];
    if (cfg?.enabled) list.push(factory(cfg));
  }
  return list;
}

function getSource(name) {
  const factory = FACTORIES[name];
  if (!factory) throw new Error(`Unknown source: ${name}`);
  return factory(config.sources[name]);
}

module.exports = { getEnabledSources, getSource };
