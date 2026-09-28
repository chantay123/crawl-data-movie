/**
 * Database Configuration - MongoDB Connection Manager
 * 
 * Quản lý lifecycle của MongoDB connection cho crawler
 */

const dns = require('dns');
try {
  dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);
} catch (_) {}

const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../utils/logger');

let isConnected = false;

/**
 * Connect to MongoDB
 * 
 * CRITICAL: Model registration happens AFTER connection succeeds
 * để tránh buffering timeout
 */
async function connect() {
  // Prevent duplicate connections
  if (isConnected && mongoose.connection.readyState === 1) {
    logger.info('Already connected to MongoDB');
    return mongoose.connection;
  }

  // Force disconnect stale connections
  if (mongoose.connection.readyState !== 0) {
    logger.info('Closing stale connection...');
    await mongoose.disconnect();
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  try {
    // Disable buffering BEFORE connecting - FAIL FAST instead of buffering
    mongoose.set('bufferCommands', false);
    mongoose.set('bufferTimeoutMS', 0); // Changed from 10000 to 0 = fail immediately
    
    logger.info(`Connecting to MongoDB: ${config.mongodb.uri}/${config.mongodb.name}`);
    
    // Connect with proper timeouts
    await mongoose.connect(config.mongodb.uri, {
      dbName: config.mongodb.name,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 30000,
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    
    // CRITICAL: Wait until readyState === 1 (connected)
    if (mongoose.connection.readyState !== 1) {
      logger.info('Waiting for connection to be fully ready...');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection ready timeout after 10s')), 10000);
        
        // Poll readyState every 100ms
        const interval = setInterval(() => {
          if (mongoose.connection.readyState === 1) {
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
          }
        }, 100);
      });
    }
    
    // Double verify with ping
    await mongoose.connection.db.admin().ping();
    logger.info('✅ MongoDB ping successful');
    
    // Triple verify: Try a simple query on admin database
    await mongoose.connection.db.admin().listDatabases();
    logger.info('✅ MongoDB query test successful');
    
    isConnected = true;
    logger.info(`✅ MongoDB fully connected and ready`);
    logger.info(`   Ready State: ${mongoose.connection.readyState} (1=connected)`);
    logger.info(`   Host: ${mongoose.connection.host}:${mongoose.connection.port}`);
    logger.info(`   Database: ${mongoose.connection.name}`);
    
    // Models will be loaded by server.js AFTER this returns
    // Do NOT load models here to avoid loading before server.js loads backend models
    
    return mongoose.connection;
    
  } catch (err) {
    logger.error(`❌ MongoDB connection failed`);
    logger.error(`   Error: ${err.message}`);
    logger.error(`   URI: ${config.mongodb.uri}/${config.mongodb.name}`);
    logger.error(`   Ready State: ${mongoose.connection.readyState}`);
    isConnected = false;
    throw err;
  }
}

/**
 * Disconnect from MongoDB
 */
async function disconnect() {
  if (!isConnected) {
    logger.info('Already disconnected from MongoDB');
    return;
  }

  await mongoose.disconnect();
  isConnected = false;
  logger.info('✅ Disconnected from MongoDB');
}

/**
 * Get connection status
 */
function getConnectionStatus() {
  return {
    isConnected,
    readyState: mongoose.connection.readyState,
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    readyStateText: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState],
    database: mongoose.connection.name,
    host: mongoose.connection.host,
    modelsCount: Object.keys(mongoose.models).length,
  };
}

module.exports = { connect, disconnect, getConnectionStatus };
