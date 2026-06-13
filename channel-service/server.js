'use strict';

// Load .env from parent directory (shared with CRM service)
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const morgan = require('morgan');
const channelRouter = require('./router');

const app = express();
const PORT = process.env.CHANNEL_PORT || 3001;

app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));

// Mount channel routes
app.use('/', channelRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Channel Service: Route not found' });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[Channel Service Error]', err.message);
  res.status(500).json({ success: false, error: err.message });
});

const server = app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║      Mini CRM — Channel Service       ║');
  console.log(`  ║      Running on port ${PORT}             ║`);
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
  console.log(`  → Send endpoint:  http://localhost:${PORT}/send`);
  console.log(`  → Health check:   http://localhost:${PORT}/health`);
  console.log(`  → Webhook target: ${process.env.CRM_RECEIPT_URL || 'http://localhost:3000/api/receipt/delivery'}`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[CHANNEL] Port ${PORT} is already in use. Kill the old process and restart.`);
    console.error('[CHANNEL] Tip: run   npx kill-port 3001   or restart your terminal.\n');
    process.exit(1);
  }
  throw err;
});

module.exports = app;
