'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/ai.controller');
const { requireFields } = require('../middleware/validate');

// ── Simple in-memory rate limiter for Gemini-backed endpoints ─────────────────
// Max 5 AI calls per minute per IP — protects free-tier quota
const aiRateMap = new Map();
const AI_RATE_LIMIT  = 5;        // max requests per window
const AI_RATE_WINDOW = 60 * 1000; // 60-second sliding window

const geminiRateLimit = (req, res, next) => {
  const ip  = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();

  if (!aiRateMap.has(ip)) aiRateMap.set(ip, []);
  const timestamps = aiRateMap.get(ip).filter(t => now - t < AI_RATE_WINDOW);
  timestamps.push(now);
  aiRateMap.set(ip, timestamps);

  if (timestamps.length > AI_RATE_LIMIT) {
    const retryAfter = Math.ceil((timestamps[0] + AI_RATE_WINDOW - now) / 1000);
    return res.status(429).json({
      success: false,
      message: `AI rate limit exceeded. Please wait ${retryAfter}s before trying again.`,
      retryAfter,
    });
  }
  next();
};

// Clean up stale IP entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of aiRateMap.entries()) {
    if (ts.every(t => now - t >= AI_RATE_WINDOW)) aiRateMap.delete(ip);
  }
}, 5 * 60 * 1000);

// ── NL Query ──────────────────────────────────────────────────────────────────
router.post('/query', geminiRateLimit, requireFields(['prompt']), ctrl.nlQuery);

// ── Content Generation ────────────────────────────────────────────────────────
router.post(
  '/generate-content',
  geminiRateLimit,
  requireFields(['audienceDescription', 'channel', 'campaignGoal']),
  ctrl.generateContent
);

// POST /api/ai/query-and-generate — Combined wizard endpoint
router.post(
  '/query-and-generate',
  geminiRateLimit,
  requireFields(['audiencePrompt', 'channel', 'campaignGoal']),
  ctrl.queryAndGenerate
);

// ── AI Campaign Suggestions ───────────────────────────────────────────────────
// Suggestions hit Gemini once per refresh — apply rate limit
router.get('/suggestions', geminiRateLimit, ctrl.getSuggestions);

// ── Segment Presets Library (no Gemini call — no rate limit needed) ───────────
router.get('/segments/presets', ctrl.getSegmentPresets);
router.post('/segments/presets/:id/preview', ctrl.previewSegmentPreset);

module.exports = router;
