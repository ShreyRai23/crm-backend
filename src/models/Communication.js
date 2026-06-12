'use strict';

const mongoose = require('mongoose');

/**
 * Communication Schema
 *
 * Represents a single message sent (or to be sent) to one customer
 * as part of a Campaign. This is the full audit trail of every delivery
 * attempt AND every engagement event.
 *
 * Lifecycle:
 *   Delivery:   pending → sent → delivered | failed
 *   Engagement: delivered → (openedAt set) → (readAt set) → (clickedAt set)
 *
 * Design decisions:
 * - `status` tracks the delivery lifecycle only (pending/sent/delivered/failed)
 * - Engagement is tracked via independent timestamp fields (openedAt, readAt, clickedAt)
 *   This decouples delivery state from engagement state, avoiding ordering issues
 *   when the channel service fires events out of sequence.
 * - vendorMessageId sparse-unique index: prevents duplicate delivery receipt processing.
 * - Each engagement timestamp has its own null-guard in the receipt controller:
 *   findOneAndUpdate({openedAt: null}) — atomic dedup without a unique index.
 */
const communicationSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    channel: {
      type: String,
      enum: ['whatsapp', 'email', 'sms', 'rcs'],
      required: true,
    },
    message: {
      type: String,
      required: true,
    },

    // ─── Delivery lifecycle ───────────────────────────────────────────────────
    /**
     * status: tracks delivery state only.
     * pending  → not yet dispatched to channel service
     * sent     → accepted by channel service (vendor returned 202)
     * delivered → confirmed delivered to recipient device
     * failed   → delivery failed (carrier rejection, unreachable, etc.)
     */
    status: {
      type: String,
      enum: ['pending', 'sent', 'delivered', 'failed'],
      default: 'pending',
    },

    /**
     * vendorMessageId: ID assigned by the Channel Service upon acceptance.
     * Used as the idempotency key for delivery receipt deduplication.
     */
    vendorMessageId: {
      type: String,
      default: null,
    },

    // Delivery timestamps
    sentAt:       { type: Date, default: null },
    deliveredAt:  { type: Date, default: null },
    failedAt:     { type: Date, default: null },
    failureReason:{ type: String, default: null },

    // ─── Engagement tracking ──────────────────────────────────────────────────
    // Each timestamp being non-null means the event occurred.
    // The receipt controller uses { openedAt: null } / { readAt: null } /
    // { clickedAt: null } as the atomic dedup guard to prevent double-counting.

    /** openedAt: set when the recipient opens/views the message */
    openedAt:  { type: Date, default: null },

    /**
     * readAt: set when the message is fully read.
     * WhatsApp / RCS: triggered by the blue read-receipt tick.
     * Email: triggered by pixel load (open tracking).
     */
    readAt:    { type: Date, default: null },

    /**
     * clickedAt: set when the recipient clicks a CTA link within the message.
     */
    clickedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
communicationSchema.index({ campaignId: 1, status: 1 });
communicationSchema.index({ customerId: 1, createdAt: -1 });
communicationSchema.index({ vendorMessageId: 1 }, { unique: true, sparse: true });
communicationSchema.index({ status: 1 });
communicationSchema.index({ createdAt: -1 });
// Engagement index: allows fast aggregation of "opened" messages per campaign
communicationSchema.index({ campaignId: 1, openedAt: 1 });
communicationSchema.index({ campaignId: 1, clickedAt: 1 });

module.exports = mongoose.model('Communication', communicationSchema);
