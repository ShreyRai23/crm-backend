'use strict';

/**
 * Delivery Service
 *
 * Responsible for firing individual message-send requests to the
 * Channel Service (the simulated external messaging vendor).
 *
 * Design decisions:
 * - Uses p-limit v3 (CommonJS) to cap concurrent HTTP requests (backpressure)
 * - Each request is fire-and-forget; delivery confirmation comes
 *   asynchronously via webhook to /api/receipt/delivery
 * - Failures in sending update Communication status to 'failed' immediately
 */

const pLimit = require('p-limit');
const axios = require('axios');
const Communication = require('../models/Communication');
const Campaign = require('../models/Campaign');

const CHANNEL_SERVICE_URL = process.env.CHANNEL_SERVICE_URL || 'http://localhost:3001';
const SEND_CONCURRENCY = parseInt(process.env.SEND_CONCURRENCY, 10) || 10;

/**
 * Sends a single communication entry to the Channel Service.
 * Updates the Communication document to 'sent' or 'failed'.
 *
 * @param {object} communication - Mongoose Communication document
 * @returns {Promise<void>}
 */
const sendSingleMessage = async (communication) => {
  try {
    const payload = {
      communicationId: communication._id.toString(),
      customerId: communication.customerId.toString(),
      campaignId: communication.campaignId.toString(),
      channel: communication.channel,
      message: communication.message,
    };

    const response = await axios.post(
      `${CHANNEL_SERVICE_URL}/send`,
      payload,
      { timeout: 10000 } // 10s timeout to channel service
    );

    const { vendorMessageId } = response.data;

    // Mark as 'sent' and record the vendor ID for webhook correlation
    await Communication.findByIdAndUpdate(communication._id, {
      $set: {
        status: 'sent',
        vendorMessageId,
        sentAt: new Date(),
      },
    });
  } catch (err) {
    console.error(`[Delivery] Failed to send communication ${communication._id}:`, err.message);

    // Mark as failed immediately if the channel service is unreachable
    await Communication.findByIdAndUpdate(communication._id, {
      $set: {
        status: 'failed',
        failedAt: new Date(),
        failureReason: `Channel service error: ${err.message}`,
      },
    });

    // Increment campaign failed stat
    await Campaign.findByIdAndUpdate(communication.campaignId, {
      $inc: { 'stats.failed': 1 },
    });
  }
};

/**
 * Dispatches all pending communications for a campaign to the Channel Service.
 * Uses p-limit to control concurrent outbound requests.
 *
 * @param {string} campaignId
 * @param {Array<object>} communications - Array of Communication documents
 * @returns {Promise<{ sent: number, failed: number }>}
 */
const dispatchCampaignMessages = async (campaignId, communications) => {
  const limiter = pLimit(SEND_CONCURRENCY);

  console.log(
    `[Delivery] Dispatching ${communications.length} messages for campaign ${campaignId} (concurrency: ${SEND_CONCURRENCY})`
  );

  const tasks = communications.map((comm) => limiter(() => sendSingleMessage(comm)));

  await Promise.allSettled(tasks);

  // Count docs that made it to 'sent'/'delivered' vs 'failed'
  const sentCount = await Communication.countDocuments({
    campaignId,
    status: { $in: ['sent', 'delivered'] },
  });

  const failedCount = await Communication.countDocuments({
    campaignId,
    status: 'failed',
  });

  console.log(`[Delivery] Dispatch complete for campaign ${campaignId}: sent=${sentCount}, failed=${failedCount}`);

  return { sent: sentCount, failed: failedCount };
};

module.exports = { dispatchCampaignMessages, sendSingleMessage };
