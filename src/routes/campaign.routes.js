'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/campaign.controller');
const { idempotency } = require('../middleware/idempotency');
const { parsePagination, validateObjectId, requireFields } = require('../middleware/validate');

// ── Stats & Aggregations (before /:id to prevent route conflicts) ─────────────
router.get('/stats', ctrl.getCampaignStats);

// ── List & Create ─────────────────────────────────────────────────────────────
router.get('/', parsePagination, ctrl.listCampaigns);

router.post(
  '/',
  idempotency(),
  requireFields(['name', 'audienceQuery', 'message', 'channel']),
  ctrl.createCampaignHandler
);

// ── Single Campaign ───────────────────────────────────────────────────────────
router.get('/:id', validateObjectId(), ctrl.getCampaign);

// ── Audience ──────────────────────────────────────────────────────────────────
router.get('/:id/audience-preview', validateObjectId(), ctrl.previewAudience);

// ── Communications ────────────────────────────────────────────────────────────
router.get('/:id/communications', validateObjectId(), parsePagination, ctrl.getCampaignCommunications);

// ── Send (async) ──────────────────────────────────────────────────────────────
router.post('/:id/send', validateObjectId(), idempotency(), ctrl.sendCampaignHandler);

// ── Clone ─────────────────────────────────────────────────────────────────────
// POST /api/campaigns/:id/clone — Duplicate a campaign as a new draft
router.post('/:id/clone', validateObjectId(), ctrl.cloneCampaign);

// ── Scheduling ────────────────────────────────────────────────────────────────
// PUT /api/campaigns/:id/schedule — Schedule for future delivery
router.put('/:id/schedule', validateObjectId(), requireFields(['scheduledAt']), ctrl.scheduleCampaign);

// DELETE /api/campaigns/:id/schedule — Cancel schedule, revert to draft
router.delete('/:id/schedule', validateObjectId(), ctrl.unscheduleCampaign);

module.exports = router;
