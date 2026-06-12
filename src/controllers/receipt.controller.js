'use strict';

/**
 * Receipt Controller
 *
 * Handles ALL incoming event webhooks from the Channel Service.
 * This covers the complete communication lifecycle:
 *
 *   Delivery events:   delivered | failed
 *   Engagement events: opened | read | clicked
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Atomicity & Idempotency guarantees:
 *
 * DELIVERY events (delivered/failed):
 *   - findOneAndUpdate filtered by { status: 'sent' }
 *   - vendorMessageId sparse-unique index = second safety net against duplicates
 *   - Campaign stats updated with $inc (atomic counter)
 *
 * ENGAGEMENT events (opened/read/clicked):
 *   - findOneAndUpdate filtered by { [eventAt]: null }
 *     e.g. for 'opened': { openedAt: null }
 *   - This null-guard is the atomic dedup: if the event already processed,
 *     openedAt is non-null → filter has no match → no-op → return skipped:true
 *   - Campaign stats updated with $inc (atomic counter per event type)
 *
 * CAMPAIGN COMPLETION:
 *   - Checked only on delivery events (delivered/failed)
 *   - Campaign marked 'completed' when no pending/sent docs remain
 *   - Engagement events continue to arrive after completion — that's by design
 * ──────────────────────────────────────────────────────────────────────────────
 */

const Communication = require('../models/Communication');
const Campaign = require('../models/Campaign');

// ─── Event type classification ────────────────────────────────────────────────
const DELIVERY_EVENTS   = ['delivered', 'failed'];
const ENGAGEMENT_EVENTS = ['opened', 'read', 'clicked'];
const ALL_VALID_EVENTS  = [...DELIVERY_EVENTS, ...ENGAGEMENT_EVENTS];

// Maps engagement event name → the Communication field that prevents double-counting
const ENGAGEMENT_TIMESTAMP_FIELD = {
  opened:  'openedAt',
  read:    'readAt',
  clicked: 'clickedAt',
};

/**
 * POST /api/receipt/delivery
 *
 * Unified webhook receiver for all Channel Service events.
 *
 * Payload from Channel Service:
 * {
 *   communicationId: string,
 *   vendorMessageId: string,
 *   status: "delivered" | "failed" | "opened" | "read" | "clicked",
 *   timestamp: string (ISO),
 *   failureReason?: string    (only for 'failed')
 *   channel?: string
 *   latencyMs?: number
 * }
 */
const handleDeliveryReceipt = async (req, res, next) => {
  try {
    const { communicationId, vendorMessageId, status, timestamp, failureReason } = req.body;

    // ── Fast-fail validation ────────────────────────────────────────────────────
    if (!communicationId || !vendorMessageId || !status) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_FIELDS',
          message: 'communicationId, vendorMessageId, and status are required',
        },
      });
    }

    if (!ALL_VALID_EVENTS.includes(status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `status must be one of: ${ALL_VALID_EVENTS.join(', ')}`,
        },
      });
    }

    const ts = timestamp ? new Date(timestamp) : new Date();

    // ── Route to appropriate handler ────────────────────────────────────────────
    if (DELIVERY_EVENTS.includes(status)) {
      return await handleDeliveryEvent({ communicationId, vendorMessageId, status, ts, failureReason, res });
    } else {
      return await handleEngagementEvent({ communicationId, vendorMessageId, status, ts, res });
    }
  } catch (err) {
    console.error('[Receipt] Unhandled error processing webhook:', err.message);
    next(err);
  }
};

// ─── Delivery event handler ───────────────────────────────────────────────────
const handleDeliveryEvent = async ({ communicationId, vendorMessageId, status, ts, failureReason, res }) => {
  const updateFields =
    status === 'delivered'
      ? { status: 'delivered', deliveredAt: ts }
      : { status: 'failed', failedAt: ts, failureReason: failureReason || 'Unknown' };

  // Atomic update: only transition from 'sent' → delivered/failed
  // This prevents re-processing if the webhook fires twice
  const updated = await Communication.findOneAndUpdate(
    {
      _id: communicationId,
      status: 'sent', // Guard: only update if still in 'sent' state
    },
    {
      $set: {
        ...updateFields,
        vendorMessageId, // Record vendor ID (sparse-unique index = second dedup layer)
      },
    },
    { new: true }
  );

  if (!updated) {
    // Already processed or invalid ID — return 200 to prevent channel service retries
    console.log(`[Receipt] Skipped delivery receipt (already processed or not found): comm=${communicationId}`);
    return res.json({ success: true, skipped: true, reason: 'Already processed or not found' });
  }

  // Atomically increment campaign delivery stats
  const statField = status === 'delivered' ? 'stats.delivered' : 'stats.failed';
  await Campaign.findByIdAndUpdate(updated.campaignId, {
    $inc: { [statField]: 1 },
  });

  // Check if ALL communications for this campaign are now in a final state
  // (no pending/sent remaining) → mark campaign 'completed'
  const pendingCount = await Communication.countDocuments({
    campaignId: updated.campaignId,
    status: { $in: ['pending', 'sent'] },
  });

  if (pendingCount === 0) {
    await Campaign.findByIdAndUpdate(updated.campaignId, {
      $set: { status: 'completed', completedAt: new Date() },
    });
    console.log(`[Receipt] Campaign ${updated.campaignId} delivery COMPLETED`);
  }

  console.log(`[Receipt] ${status.toUpperCase()} — comm=${communicationId} vendor=${vendorMessageId}`);
  return res.json({ success: true, updated: true, communicationId, status });
};

// ─── Engagement event handler ─────────────────────────────────────────────────
const handleEngagementEvent = async ({ communicationId, vendorMessageId, status, ts, res }) => {
  const timestampField = ENGAGEMENT_TIMESTAMP_FIELD[status]; // e.g. 'openedAt'

  // Atomic update: null-guard on the timestamp field prevents double-counting.
  // If { openedAt: null } doesn't match (already set), findOneAndUpdate returns null → skip.
  const updated = await Communication.findOneAndUpdate(
    {
      _id: communicationId,
      [timestampField]: null,              // Dedup: only process if this event hasn't been recorded
      status: { $nin: ['pending', 'failed'] }, // Must have been delivered first
    },
    {
      $set: { [timestampField]: ts },
    },
    { new: true }
  );

  if (!updated) {
    // Either already processed or comm is in pending/failed state — both are fine
    console.log(`[Receipt] Skipped engagement event (already processed or not deliverable): ` +
      `comm=${communicationId} event=${status}`);
    return res.json({ success: true, skipped: true, reason: 'Already processed or not applicable' });
  }

  // Atomically increment the campaign's engagement stat counter
  await Campaign.findByIdAndUpdate(updated.campaignId, {
    $inc: { [`stats.${status}`]: 1 },
  });

  console.log(`[Receipt] ${status.toUpperCase()} — comm=${communicationId} vendor=${vendorMessageId}`);
  return res.json({ success: true, updated: true, communicationId, status });
};

module.exports = { handleDeliveryReceipt };
