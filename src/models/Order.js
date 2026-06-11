'use strict';

const mongoose = require('mongoose');

/**
 * Order Item Sub-schema
 * Represents a single line item within an order.
 */
const orderItemSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    price:    { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

/**
 * Order Schema
 *
 * Represents a purchase transaction linked to a Customer.
 * Used by the AI audience-query engine for spend-based segmentation,
 * and by the attribution system to measure campaign ROI.
 *
 * Attribution fields allow linking a purchase back to the Campaign
 * and specific Communication that influenced it — answering the PDF's
 * requirement: "order came because of this communication".
 */
const orderSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'customerId is required'],
    },
    amount: {
      type: Number,
      required: [true, 'Order amount is required'],
      min: [0, 'Amount cannot be negative'],
    },
    items: {
      type: [orderItemSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
      default: 'delivered',
    },
    // Store purchase date explicitly for flexible time-based querying
    purchasedAt: {
      type: Date,
      default: Date.now,
    },

    // ─── Campaign Attribution ─────────────────────────────────────────────────
    /**
     * Attribution links this order to the Campaign & Communication
     * that influenced the purchase decision.
     *
     * Attribution model: "Last-touch within 7-day window"
     * If a customer received a campaign communication and placed an order
     * within 7 days, the order can be attributed to that campaign.
     *
     * attributedCampaignId:      the Campaign that gets credit
     * attributedCommunicationId: the specific Communication sent to this customer
     * attributedAt:              when attribution was recorded
     * attributionWindowDays:     the lookback window used (default: 7)
     */
    attributedCampaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      default: null,
    },
    attributedCommunicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Communication',
      default: null,
    },
    attributedAt: {
      type: Date,
      default: null,
    },
    attributionWindowDays: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
orderSchema.index({ customerId: 1, createdAt: -1 });   // Customer order history
orderSchema.index({ amount: -1 });                      // High-value orders
orderSchema.index({ purchasedAt: -1 });                 // Time-range queries
orderSchema.index({ status: 1 });
orderSchema.index({ attributedCampaignId: 1 });         // Campaign attribution lookups
// Compound: used by NL queries like "orders > $500 in last year"
orderSchema.index({ customerId: 1, purchasedAt: -1, amount: -1 });

module.exports = mongoose.model('Order', orderSchema);
