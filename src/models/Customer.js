'use strict';

const mongoose = require('mongoose');

/**
 * Customer Schema
 *
 * Core entity of the CRM. Represents a B2C end-consumer.
 * Indexed heavily for read-heavy audience-segmentation queries.
 */
const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    phone: {
      type: String,
      trim: true,
      default: null,
    },
    totalSpend: {
      type: Number,
      default: 0,
      min: [0, 'totalSpend cannot be negative'],
    },
    visitCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastVisit: {
      type: Date,
      default: null,
    },
    tags: {
      type: [String],
      default: [],
    },
    preferredChannel: {
      type: String,
      enum: ['whatsapp', 'email', 'sms', 'rcs'],
      default: 'email',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    city: {
      type: String,
      trim: true,
      default: null,
    },
    country: {
      type: String,
      trim: true,
      default: 'IN',
    },

    // ─── Opt-Out / Unsubscribe Management ────────────────────────────────────
    /**
     * optedOutChannels: list of channels this customer has unsubscribed from.
     * Audience resolution in campaign.service.js filters these customers out
     * before dispatching any messages — guaranteeing GDPR/DPDP compliance.
     *
     * A customer can be opted-out of specific channels (e.g. just SMS) while
     * still receiving messages via whatsapp.
     */
    optedOutChannels: {
      type: [String],
      enum: ['whatsapp', 'email', 'sms', 'rcs'],
      default: [],
    },
    /**
     * optedOutAt: timestamp of the most recent opt-out action.
     * If optedOutChannels is empty, this field is null.
     */
    optedOutAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
customerSchema.index({ email: 1 }, { unique: true });
customerSchema.index({ totalSpend: -1 });                   // Audience: "top spenders"
customerSchema.index({ lastVisit: -1 });                    // Audience: "inactive users"
customerSchema.index({ createdAt: -1 });                    // Cursor-based pagination
customerSchema.index({ tags: 1 });                          // Tag-based filtering
customerSchema.index({ preferredChannel: 1 });
customerSchema.index({ isActive: 1, createdAt: -1 });       // Compound: active customers list
customerSchema.index({ optedOutChannels: 1 });              // Opt-out filter (delivery exclusion)

// ─── Virtuals ─────────────────────────────────────────────────────────────────
customerSchema.virtual('orders', {
  ref: 'Order',
  localField: '_id',
  foreignField: 'customerId',
  justOne: false,
});

module.exports = mongoose.model('Customer', customerSchema);
