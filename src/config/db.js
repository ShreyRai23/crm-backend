'use strict';

const dns = require('dns');
const mongoose = require('mongoose');

// ─── Google DNS resolver ────────────────────────────────────────────────────
// Forces Node's DNS resolution through Google's public nameservers.
// This prevents intermittent ENOTFOUND errors on certain networks when
// resolving *.mongodb.net SRV records.
dns.setServers(['8.8.8.8', '8.8.4.4']);

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('[DB] MONGODB_URI is not defined in environment variables.');
  process.exit(1);
}

// Mongoose global settings
mongoose.set('strictQuery', true);

/**
 * Establishes a connection to MongoDB Atlas.
 * Exits the process on irrecoverable error.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGODB_URI, {
      // Atlas recommended options
      serverSelectionTimeoutMS: 10000, // 10s to find a server
      socketTimeoutMS: 45000,          // 45s socket timeout
      connectTimeoutMS: 10000,         // 10s connect timeout
      maxPoolSize: 20,                 // connection pool
      family: 4,                       // Force IPv4 (avoids IPv6 SRV issues)
    });

    console.log(`[DB] MongoDB connected: ${conn.connection.host}`);
    console.log(`[DB] Database: ${conn.connection.name}`);
  } catch (err) {
    console.error(`[DB] Connection error: ${err.message}`);
    process.exit(1);
  }
};

// ─── Connection lifecycle hooks ─────────────────────────────────────────────
mongoose.connection.on('disconnected', () => {
  console.warn('[DB] MongoDB disconnected. Attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
  console.log('[DB] MongoDB reconnected.');
});

mongoose.connection.on('error', (err) => {
  console.error(`[DB] Runtime error: ${err.message}`);
});

module.exports = connectDB;
