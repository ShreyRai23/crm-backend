'use strict';

const mongoose = require('mongoose');

/**
 * Campaign Schema
 *
 * Represents a marketing campaign targeting an audience segment.
 * The audienceQuery field stores a validated MongoDB aggregation pipeline,
 * built either manually or via the AI NL→pipeline engine.
 *
 * Status lifecycle:
 *   draft → running → completed | failed
 *   draft → scheduled → running → completed | failed
 *
 * stats breakdown:
 *   Delivery:    sent, delivered, failed
 *   Engagement:  opened, read, clicked    (subset of delivered)
 *   Attribution: conversions, revenue     (orders attributed to this campaign)
 */
const campaignSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Campaign name is required'],
      trim: true,
      maxlength: [200, 'Campaign name cannot exceed 200 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    /**
     * audienceQuery: The stored MongoDB aggregation pipeline stages
     * that define who receives this campaign.
     * Validated against an operator allowlist before storage.
     */
    audienceQuery: {
      type: mongoose.Schema.Types.Mixed,
      required: [true, 'audienceQuery (pipeline) is required'],
    },
    audienceSize: {
      type: Number,
      default: 0,
    },
    message: {
      type: String,
      required: [true, 'Campaign message is required'],
      maxlength: [2000, 'Message cannot exceed 2000 characters'],
    },
    channel: {
      type: String,
      enum: ['whatsapp', 'email', 'sms', 'rcs'],
      required: [true, 'Channel is required'],
    },
    /**
     * Status lifecycle:
     *   draft     → manually created, awaiting send trigger
     *   scheduled → has a future scheduledAt time; scheduler will auto-send
     *   running   → currently dispatching messages to the channel service
     *   completed → all messages dispatched; delivery results arriving via webhook
     *   failed    → campaign encountered a fatal error during dispatch
     */
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'running', 'completed', 'failed'],
      default: 'draft',
    },
    /**
     * idempotencyKey: Client-supplied UUID to prevent duplicate campaigns.
     * Sparse+unique: only enforced when the field is present.
     */
    idempotencyKey: {
      type: String,
      default: null,
    },
    /**
     * scheduledAt: Future ISO timestamp at which the scheduler will auto-send.
     * Only relevant when status = 'scheduled'.
     * Set via PUT /api/campaigns/:id/schedule
     */
    scheduledAt: {
      type: Date,
      default: null,
    },

    /**
     * stats: Full performance metrics for this campaign.
     *
     * Delivery funnel:
     *   sent      → total messages dispatched to channel service
     *   delivered → confirmed reached recipient device
     *   failed    → delivery failed
     *
     * Engagement funnel (subset of delivered):
     *   opened    → recipient opened/viewed the message
     *   read      → recipient fully read (WhatsApp blue ticks / email pixel)
     *   clicked   → recipient clicked a CTA link
     *
     * Attribution (business outcomes):
     *   conversions → number of orders attributed to this campaign
     *   revenue     → total ₹ value of attributed orders
     */
    stats: {
      // Delivery
      sent:        { type: Number, default: 0 },
      delivered:   { type: Number, default: 0 },
      failed:      { type: Number, default: 0 },
      // Engagement
      opened:      { type: Number, default: 0 },
      read:        { type: Number, default: 0 },
      clicked:     { type: Number, default: 0 },
      // Attribution
      conversions: { type: Number, default: 0 },
      revenue:     { type: Number, default: 0 },
    },

    sentAt:      { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
campaignSchema.index({ status: 1, createdAt: -1 });
campaignSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
campaignSchema.index({ createdAt: -1 });
campaignSchema.index({ channel: 1 });
// Scheduler index: fast lookup for due campaigns
campaignSchema.index({ status: 1, scheduledAt: 1 });

module.exports = mongoose.model('Campaign', campaignSchema);
