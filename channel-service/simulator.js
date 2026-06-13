'use strict';

/**
 * Channel Service Simulator
 *
 * Simulates the full communication lifecycle of a real messaging vendor
 * (Twilio, Meta Business API, Kaleyra, etc.).
 *
 * Full event chain per message:
 *   1. Delivery event    → "delivered" or "failed"       (fired after random 500ms-5s)
 *   2. Opened event      → 60% of delivered              (fired 2-8s after delivery)
 *   3. Read event        → 70% of opened (WA/RCS)        (fired 1-4s after opened)
 *      OR
 *      Click event       → 30% of opened (email/sms)     (fired 5-15s after opened)
 *   4. Click event       → 25% of those who read         (fired 5-15s after read)
 *
 * This models the realistic engagement funnel:
 *   Sent → Delivered → Opened → Read → Clicked
 *
 * All events are fired as async HTTP POST webhooks to the CRM Receipt API,
 * simulating how real vendor platforms (WhatsApp Business API, Mailchimp, etc.)
 * fire webhooks for each event in the message lifecycle.
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const CRM_RECEIPT_URL = process.env.CRM_RECEIPT_URL || 'http://localhost:3000/api/receipt/delivery';
const SUCCESS_RATE    = parseInt(process.env.DELIVERY_SUCCESS_RATE, 10) || 90;
const MIN_LATENCY     = parseInt(process.env.MIN_LATENCY_MS, 10) || 500;
const MAX_LATENCY     = parseInt(process.env.MAX_LATENCY_MS, 10) || 5000;

// ─── Engagement rates (realistic approximations) ─────────────────────────────
const OPEN_RATE   = 0.60;  // 60% of delivered messages get opened
const READ_RATE   = 0.70;  // 70% of opened WhatsApp/RCS messages get read-receipt
const CLICK_RATE  = 0.28;  // 28% of opened messages get a CTA click

// ─── Engagement timing (compressed for demo — represents real-world minutes) ──
// In reality: opens happen ~2min, reads ~5min, clicks ~10min after delivery
// For demo: we compress to seconds so results are visible quickly
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ─── Webhook helper ───────────────────────────────────────────────────────────
/**
 * Fires a single webhook to the CRM Receipt API.
 * Silently swallows errors — the channel service doesn't crash on CRM downtime.
 */
const fireWebhook = async (payload) => {
  try {
    await axios.post(CRM_RECEIPT_URL, payload, { timeout: 10000 });
    console.log(
      `[Channel] → CRM webhook: comm=${payload.communicationId} ` +
      `vendor=${payload.vendorMessageId} event=${payload.status}`
    );
  } catch (err) {
    console.error(`[Channel] Webhook failed (${payload.status}) for ${payload.vendorMessageId}:`, err.message);
    // In production: push to retry queue with exponential backoff
  }
};

// ─── Failure reason picker ────────────────────────────────────────────────────
const pickFailureReason = () => {
  const reasons = [
    'User phone unreachable',
    'Number not registered on WhatsApp',
    'Spam filter triggered',
    'Carrier rejection',
    'Rate limit exceeded',
    'Invalid phone number format',
    'User blocked business number',
    'Inbox full',
    'DND (Do Not Disturb) active',
    'RCS not supported on device',
  ];
  return reasons[Math.floor(Math.random() * reasons.length)];
};

// ─── Engagement event simulator ───────────────────────────────────────────────
/**
 * After a successful delivery, simulates the recipient's engagement
 * by firing sequential webhook events with realistic timing.
 *
 * @param {object} payload - Original message payload from CRM
 * @param {string} vendorMessageId - The vendor ID for this message
 * @param {string} channel - 'whatsapp' | 'email' | 'sms' | 'rcs'
 */
const simulateEngagement = async (payload, vendorMessageId, channel) => {
  // ── Step 1: Opened ──────────────────────────────────────────────────────────
  if (Math.random() >= OPEN_RATE) return; // 40% don't open

  const openDelay = randomBetween(2000, 8000); // 2-8s (represents 2-8 min in reality)
  await new Promise((r) => setTimeout(r, openDelay));

  await fireWebhook({
    communicationId: payload.communicationId,
    vendorMessageId,
    status: 'opened',
    timestamp: new Date().toISOString(),
    channel,
  });

  // ── Step 2a: Read (WhatsApp / RCS — blue tick read receipts) ────────────────
  const supportsReadReceipts = ['whatsapp', 'rcs'].includes(channel);

  if (supportsReadReceipts && Math.random() < READ_RATE) {
    const readDelay = randomBetween(1000, 4000); // 1-4s after opened
    await new Promise((r) => setTimeout(r, readDelay));

    await fireWebhook({
      communicationId: payload.communicationId,
      vendorMessageId,
      status: 'read',
      timestamp: new Date().toISOString(),
      channel,
    });
  }

  // ── Step 2b: Email / SMS — open tracking pixel counts as "read" ─────────────
  if (['email', 'sms'].includes(channel) && Math.random() < 0.80) {
    // Email/SMS: treat "opened" as effectively "read" — fire read event too
    const readDelay = randomBetween(500, 2000);
    await new Promise((r) => setTimeout(r, readDelay));

    await fireWebhook({
      communicationId: payload.communicationId,
      vendorMessageId,
      status: 'read',
      timestamp: new Date().toISOString(),
      channel,
    });
  }

  // ── Step 3: Clicked ─────────────────────────────────────────────────────────
  if (Math.random() < CLICK_RATE) {
    const clickDelay = randomBetween(5000, 15000); // 5-15s after opened
    await new Promise((r) => setTimeout(r, clickDelay));

    await fireWebhook({
      communicationId: payload.communicationId,
      vendorMessageId,
      status: 'clicked',
      timestamp: new Date().toISOString(),
      channel,
    });
  }
};

// ─── Delivery simulator ───────────────────────────────────────────────────────
/**
 * Simulates the delivery attempt with random latency and outcome,
 * then triggers the engagement simulation chain for delivered messages.
 *
 * @param {object} payload - CRM message payload
 * @param {string} vendorMessageId - Pre-assigned vendor ID
 */
const simulateDelivery = async (payload, vendorMessageId) => {
  // Simulate network/carrier latency
  const deliveryDelay = randomBetween(MIN_LATENCY, MAX_LATENCY);
  await new Promise((r) => setTimeout(r, deliveryDelay));

  // Roll delivery outcome
  const isDelivered = Math.random() * 100 < SUCCESS_RATE;
  const status = isDelivered ? 'delivered' : 'failed';

  // Fire delivery webhook
  await fireWebhook({
    communicationId: payload.communicationId,
    vendorMessageId,
    status,
    timestamp: new Date().toISOString(),
    failureReason: isDelivered ? undefined : pickFailureReason(),
    channel: payload.channel,
    latencyMs: deliveryDelay,
  });

  // If delivered, kick off the engagement simulation chain
  if (isDelivered) {
    // Don't await — engagement events happen independently after delivery
    simulateEngagement(payload, vendorMessageId, payload.channel).catch((err) => {
      console.error('[Channel] Engagement simulation error:', err.message);
    });
  }
};

// ─── Entry point ──────────────────────────────────────────────────────────────
/**
 * Accepts a message from the CRM, assigns a vendorMessageId synchronously,
 * and kicks off the full async delivery+engagement simulation.
 *
 * @param {object} payload - CRM message payload
 * @returns {{ vendorMessageId: string }}
 */
const processMessage = (payload) => {
  const vendorMessageId = `vendor_${uuidv4()}`;

  setImmediate(() => {
    simulateDelivery(payload, vendorMessageId).catch((err) => {
      console.error('[Channel] Simulation error:', err.message);
    });
  });

  return { vendorMessageId };
};

module.exports = { processMessage };
