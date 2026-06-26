'use strict';

// ─── Load environment variables first ────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const connectDB = require('./config/db');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { startScheduler } = require('./services/scheduler.service');

// ─── Route imports ────────────────────────────────────────────────────────────
const authRoutes      = require('./routes/auth.routes');
const customerRoutes  = require('./routes/customer.routes');
const orderRoutes     = require('./routes/order.routes');
const campaignRoutes  = require('./routes/campaign.routes');
const aiRoutes        = require('./routes/ai.routes');
const receiptRoutes   = require('./routes/receipt.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const { protect }     = require('./middleware/auth.middleware');

// ─── Embedded Channel Service (production-only) ───────────────────────────────
// When EMBEDDED_CHANNEL=true the channel simulator is mounted directly on the
// CRM app instead of running as a separate process on port 3001.
// This makes single-dyno deployments (Render free tier) work correctly.
const EMBEDDED_CHANNEL = process.env.EMBEDDED_CHANNEL === 'true';

// ─── App initialization ───────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security & utility middleware ────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow no-origin requests (curl, Postman, server-to-server)
      if (!origin) return callback(null, true);
      const allowed = [
        process.env.FRONTEND_URL,           // e.g. https://kinetics-crm.vercel.app
      ].filter(Boolean);
      // Also allow any Vercel preview deployment URL
      const isVercel = origin.endsWith('.vercel.app');
      if (isVercel || allowed.includes(origin) || !process.env.FRONTEND_URL) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'CRM Service',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    features: [
      'campaign-scheduling',
      'engagement-tracking',
      'opt-out-management',
      'ai-suggestions',
      'segment-presets',
      'attribution-tracking',
      'analytics-dashboard',
    ],
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
// Auth is public — no protect middleware
app.use('/api/auth',       authRoutes);

// All other routes require a valid JWT
app.use('/api/customers',  protect, customerRoutes);
app.use('/api/orders',     protect, orderRoutes);
app.use('/api/campaigns',  protect, campaignRoutes);
app.use('/api/ai',         protect, aiRoutes);
app.use('/api/receipt',    receiptRoutes);   // Webhooks from channel service — no user token
app.use('/api/analytics',  protect, analyticsRoutes);

// ─── Embedded Channel Service routes (production only) ────────────────────────
if (EMBEDDED_CHANNEL) {
  const channelRouter = require('../channel-service/router');
  app.use('/channel', channelRouter);
  console.log('[Server] Channel Service embedded on /channel (production mode)');
}

// ─── 404 & Error handlers ─────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Start server ─────────────────────────────────────────────────────────────
const startServer = async () => {
  await connectDB();

  // Start the background campaign scheduler after DB is connected
  startScheduler();

  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║      Mini CRM v2.0 — CRM Service             ║');
    console.log(`  ║      Running on port ${PORT}                    ║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('  Core Endpoints:');
    console.log(`  → Customers    http://localhost:${PORT}/api/customers`);
    console.log(`  → Orders       http://localhost:${PORT}/api/orders`);
    console.log(`  → Campaigns    http://localhost:${PORT}/api/campaigns`);
    console.log(`  → AI           http://localhost:${PORT}/api/ai`);
    console.log(`  → Receipt      http://localhost:${PORT}/api/receipt`);
    console.log('');
    console.log('  New Feature Endpoints:');
    console.log(`  → Analytics    http://localhost:${PORT}/api/analytics/overview`);
    console.log(`  → AI Suggest   http://localhost:${PORT}/api/ai/suggestions`);
    console.log(`  → Seg Presets  http://localhost:${PORT}/api/ai/segments/presets`);
    console.log(`  → Health       http://localhost:${PORT}/health`);
    console.log('');
    console.log('  Background Services:');
    console.log('  → Campaign Scheduler  [RUNNING] (polls every 60s)');
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[CRM] Port ${PORT} is already in use. Kill the old process and restart.`);
      console.error('[CRM] Tip: run   npx kill-port 3000   or restart your terminal.\n');
      process.exit(1);
    }
    throw err;
  });

};

startServer().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});

module.exports = app;
