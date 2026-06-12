'use strict';

/**
 * Campaign Service
 *
 * Core business logic for campaign creation and execution.
 *
 * Key responsibilities:
 * 1. Building and validating audience pipelines
 * 2. Computing audience size previews
 * 3. Creating Communication documents in bulk
 * 4. Orchestrating the dispatch lifecycle
 */

const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const Communication = require('../models/Communication');
const Customer = require('../models/Customer');
const { dispatchCampaignMessages } = require('./delivery.service');
const { AppError } = require('../middleware/errorHandler');

/**
 * Runs an audience pipeline against the customers collection and
 * returns the matched customers.
 *
 * IMPORTANT: Appends an opt-out exclusion stage for the given channel.
 * Customers who have opted out of that channel are never sent messages,
 * regardless of what the audience pipeline selects.
 *
 * @param {Array} pipeline - Validated aggregation pipeline
 * @param {string} [channel] - Campaign channel for opt-out exclusion
 * @returns {Promise<Array>} Array of customer documents
 */
const resolveAudience = async (pipeline, channel) => {
  const enrichedPipeline = [
    ...pipeline,
    // ── Opt-out exclusion (compliance) ──────────────────────────────────────
    // Exclude customers who have explicitly unsubscribed from this channel.
    // This runs AFTER the main audience filter to ensure opted-out customers
    // are never sent messages even if they match all other criteria.
    ...(channel
      ? [{ $match: { optedOutChannels: { $nin: [channel] } } }]
      : []),
    {
      $project: {
        _id: 1,
        name: 1,
        email: 1,
        phone: 1,
        preferredChannel: 1,
      },
    },
    // Safety cap: never send to more than 10,000 customers in a single campaign
    { $limit: 10000 },
  ];

  return Customer.aggregate(enrichedPipeline);
};

/**
 * Previews the audience size for a given pipeline without sending.
 * @param {Array} pipeline
 * @returns {Promise<number>}
 */
const previewAudienceSize = async (pipeline) => {
  const countPipeline = [
    ...pipeline,
    { $count: 'total' },
  ];
  const result = await Customer.aggregate(countPipeline);
  return result.length > 0 ? result[0].total : 0;
};

/**
 * Creates a new campaign.
 * Handles idempotency: if a campaign with the same idempotencyKey exists,
 * returns the existing one instead of creating a duplicate.
 *
 * @param {object} data - Campaign creation payload
 * @returns {Promise<{ campaign: object, isNew: boolean }>}
 */
const createCampaign = async (data) => {
  const { name, description, audienceQuery, message, channel, idempotencyKey } = data;

  // Idempotency check: return existing campaign if key already used
  if (idempotencyKey) {
    const existing = await Campaign.findOne({ idempotencyKey });
    if (existing) {
      console.log(`[Campaign] Idempotency hit: returning existing campaign ${existing._id}`);
      return { campaign: existing, isNew: false };
    }
  }

  // Preview audience size to store on the campaign
  let audienceSize = 0;
  try {
    audienceSize = await previewAudienceSize(audienceQuery);
  } catch (err) {
    throw new AppError(`Invalid audience pipeline: ${err.message}`, 400, 'INVALID_PIPELINE');
  }

  const campaign = await Campaign.create({
    name,
    description,
    audienceQuery,
    audienceSize,
    message,
    channel,
    idempotencyKey: idempotencyKey || null,
    status: 'draft',
  });

  return { campaign, isNew: true };
};

/**
 * Executes a campaign: resolves the audience, creates Communication records,
 * updates campaign status, and triggers async dispatch to the Channel Service.
 *
 * This function returns quickly after kicking off the async dispatch.
 * The actual delivery results come back via webhook.
 *
 * @param {string} campaignId
 * @returns {Promise<{ campaign: object, audienceSize: number }>}
 */
const sendCampaign = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new AppError('Campaign not found', 404, 'NOT_FOUND');
  }

  if (campaign.status === 'running') {
    throw new AppError(
      'Campaign is already running. Wait for it to complete.',
      409,
      'CAMPAIGN_ALREADY_RUNNING'
    );
  }

  if (campaign.status === 'completed') {
    throw new AppError(
      'Campaign has already been sent. Create a new campaign to resend.',
      409,
      'CAMPAIGN_ALREADY_COMPLETED'
    );
  }

  // ─── Resolve audience ───────────────────────────────────────────────────────
  let audience;
  try {
    // Pass channel so opted-out customers are excluded from delivery
    audience = await resolveAudience(campaign.audienceQuery, campaign.channel);
  } catch (err) {
    await Campaign.findByIdAndUpdate(campaignId, { status: 'failed' });
    throw new AppError(`Audience resolution failed: ${err.message}`, 500, 'AUDIENCE_ERROR');
  }

  if (audience.length === 0) {
    throw new AppError(
      'No customers matched the campaign audience criteria.',
      400,
      'EMPTY_AUDIENCE'
    );
  }

  // ─── Update campaign status to running ─────────────────────────────────────
  await Campaign.findByIdAndUpdate(campaignId, {
    $set: {
      status: 'running',
      audienceSize: audience.length,
      sentAt: new Date(),
      // Reset delivery stats; engagement stats accumulate via webhooks
      'stats.sent':      0,
      'stats.delivered': 0,
      'stats.failed':    0,
      'stats.opened':    0,
      'stats.read':      0,
      'stats.clicked':   0,
    },
  });

  // ─── Bulk-create Communication documents ───────────────────────────────────
  const communicationDocs = audience.map((customer) => ({
    campaignId: campaign._id,
    customerId: customer._id,
    channel: campaign.channel,
    message: campaign.message,
    status: 'pending',
  }));

  // insertMany with ordered:false for partial success resilience
  const insertedComms = await Communication.insertMany(communicationDocs, {
    ordered: false,
  });

  // ── Fix: set stats.sent to the actual number of queued communications ──────
  // This gives the frontend an accurate "queued" count immediately,
  // before delivery webhooks start arriving.
  await Campaign.findByIdAndUpdate(campaignId, {
    $set: { 'stats.sent': insertedComms.length },
  });

  console.log(`[Campaign] Created ${insertedComms.length} communication records for campaign ${campaignId}`);

  // ─── Async dispatch (non-blocking) ─────────────────────────────────────────
  // We intentionally do NOT await this — it runs in the background.
  // The campaign status will be updated to 'completed' once all webhooks arrive.
  setImmediate(async () => {
    try {
      await dispatchCampaignMessages(campaignId, insertedComms);
    } catch (err) {
      console.error(`[Campaign] Dispatch error for campaign ${campaignId}:`, err.message);
      await Campaign.findByIdAndUpdate(campaignId, { status: 'failed' });
    }
  });

  return {
    campaign: await Campaign.findById(campaignId),
    audienceSize: audience.length,
    communicationsCreated: insertedComms.length,
  };
};

module.exports = { createCampaign, sendCampaign, previewAudienceSize, resolveAudience };
