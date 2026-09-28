/**
 * Backend Models Loader - DEPRECATED
 * 
 * Models are now stored locally in crawler/src/models/
 * This file is kept for backward compatibility and will be removed.
 * 
 * All models are now imported directly from ./models/index.js
 */

const models = require('../models');

module.exports = { loadBackendModels: () => models };
