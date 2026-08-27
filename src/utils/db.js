const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../utils/logger');

async function connect() {
  try {
    await mongoose.connect(config.mongodb.uri, {
      serverSelectionTimeoutMS: 10000,
    });
    logger.info(`Connected to MongoDB: ${config.mongodb.uri}`);
    return mongoose.connection;
  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`);
    throw err;
  }
}

async function disconnect() {
  await mongoose.disconnect();
  logger.info('Disconnected from MongoDB');
}

module.exports = { connect, disconnect };
