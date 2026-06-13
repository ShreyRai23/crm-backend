'use strict';

const router = require('express').Router();
const { processMessage } = require('./simulator');

/**
 * POST /send
 *
 * Accepts a message send request from the CRM Service.
 * Returns immediately with a vendorMessageId.
 * The actual delivery status comes back asynchronously via webhook.
 *
 * Body: {
 *   communicationId: string,
 *   customerId: string,
 *   campaignId: string,
 *   channel: string,
 *   message: string
 * }
 */
router.post('/send', (req, res) => {
  const { communicationId, customerId, campaignId, channel, message } = req.body;

  if (!communicationId || !channel || !message) {
    return res.status(400).json({
      success: false,
      error: 'communicationId, channel, and message are required',
    });
  }

  // Process message (assigns vendorMessageId, kicks off async simulation)
  const { vendorMessageId } = processMessage({ communicationId, customerId, campaignId, channel, message });

  console.log(`[Channel] Accepted message → comm=${communicationId} vendor=${vendorMessageId} channel=${channel}`);

  // Return immediately with vendor tracking ID
  return res.status(202).json({
    success: true,
    vendorMessageId,
    status: 'accepted',
    message: 'Message accepted for delivery. Status will be posted to CRM webhook.',
  });
});

/**
 * GET /health
 */
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'Channel Service',
    status: 'healthy',
    config: {
      successRate: `${process.env.DELIVERY_SUCCESS_RATE || 90}%`,
      latencyRange: `${process.env.MIN_LATENCY_MS || 500}ms–${process.env.MAX_LATENCY_MS || 5000}ms`,
      webhookTarget: process.env.CRM_RECEIPT_URL || 'http://localhost:3000/api/receipt/delivery',
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
