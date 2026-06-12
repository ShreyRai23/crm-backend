'use strict';

const Campaign = require('../models/Campaign');
const Communication = require('../models/Communication');
const Order = require('../models/Order');
const { createCampaign, sendCampaign, previewAudienceSize } = require('../services/campaign.service');
const { AppError } = require('../middleware/errorHandler');

/**
 * GET /api/campaigns
 * Paginated campaign list with status/channel filter.
 */
const listCampaigns = async (req, res, next) => {
  try {
    const { limit, skip, page } = req.pagination;
    const { status, channel } = req.query;

    const filter = {};
    if (status)  filter.status  = status;
    if (channel) filter.channel = channel;

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Campaign.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: campaigns,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: skip + campaigns.length < total,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/campaigns/:id
 * Single campaign with full funnel stats (delivery + engagement + attribution).
 */
const getCampaign = async (req, res, next) => {
  try {
    const campaign = await Campaign.findById(req.params.id).lean();
    if (!campaign) return next(new AppError('Campaign not found', 404, 'NOT_FOUND'));

    // ── Live stats from Communications collection ────────────────────────────
    // Delivery: grouped by status field
    // Engagement: count non-null timestamp fields (independent of delivery status)
    const [liveStats] = await Communication.aggregate([
      { $match: { campaignId: campaign._id } },
      {
        $group: {
          _id: null,
          // Delivery funnel
          pending:   { $sum: { $cond: [{ $eq: ['$status', 'pending'] },   1, 0] } },
          sent:      { $sum: { $cond: [{ $eq: ['$status', 'sent'] },      1, 0] } },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          failed:    { $sum: { $cond: [{ $eq: ['$status', 'failed'] },    1, 0] } },
          // Engagement funnel (non-null timestamp = event occurred)
          opened:  { $sum: { $cond: [{ $ne: ['$openedAt',  null] }, 1, 0] } },
          read:    { $sum: { $cond: [{ $ne: ['$readAt',    null] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } },
        },
      },
    ]);

    // ── Compute derived rates ────────────────────────────────────────────────
    const ls = liveStats || {};
    const totalDelivered = ls.delivered || 0;
    const rates = totalDelivered > 0 ? {
      deliveryRate: +(((totalDelivered) / ((totalDelivered + (ls.failed || 0)) || 1)) * 100).toFixed(1),
      openRate:     +((( ls.opened  || 0) / totalDelivered) * 100).toFixed(1),
      readRate:     +((( ls.read    || 0) / totalDelivered) * 100).toFixed(1),
      clickRate:    +((( ls.clicked || 0) / totalDelivered) * 100).toFixed(1),
    } : { deliveryRate: 0, openRate: 0, readRate: 0, clickRate: 0 };

    // ── Attribution: orders attributed to this campaign ───────────────────────
    const attribution = await Order.aggregate([
      { $match: { attributedCampaignId: campaign._id } },
      {
        $group: {
          _id: null,
          conversions: { $sum: 1 },
          revenue:     { $sum: '$amount' },
        },
      },
    ]);
    const attributionData = attribution[0] || { conversions: 0, revenue: 0 };

    return res.json({
      success: true,
      data: {
        ...campaign,
        liveStats: {
          pending:   ls.pending   || 0,
          sent:      ls.sent      || 0,
          delivered: ls.delivered || 0,
          failed:    ls.failed    || 0,
          opened:    ls.opened    || 0,
          read:      ls.read      || 0,
          clicked:   ls.clicked   || 0,
        },
        rates,
        attribution: attributionData,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/campaigns
 * Create a new campaign. Supports Idempotency-Key header.
 * Body: { name, description, audienceQuery, message, channel }
 */
const createCampaignHandler = async (req, res, next) => {
  try {
    const { name, description, audienceQuery, message, channel } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || null;

    const { campaign, isNew } = await createCampaign({
      name, description, audienceQuery, message, channel, idempotencyKey,
    });

    return res.status(isNew ? 201 : 200).json({
      success: true,
      data: campaign,
      message: isNew ? 'Campaign created successfully' : 'Existing campaign returned (idempotency)',
      isNew,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/campaigns/:id/send
 * Triggers the async send workflow. Returns immediately;
 * delivery + engagement results arrive via webhook.
 */
const sendCampaignHandler = async (req, res, next) => {
  try {
    const result = await sendCampaign(req.params.id);
    return res.json({
      success: true,
      message: `Campaign send initiated. ${result.communicationsCreated} messages queued for delivery.`,
      data: {
        campaignId: result.campaign._id,
        status: result.campaign.status,
        audienceSize: result.audienceSize,
        communicationsCreated: result.communicationsCreated,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/campaigns/:id/audience-preview
 * Previews audience size without sending.
 */
const previewAudience = async (req, res, next) => {
  try {
    const campaign = await Campaign.findById(req.params.id).lean();
    if (!campaign) return next(new AppError('Campaign not found', 404, 'NOT_FOUND'));

    const audienceSize = await previewAudienceSize(campaign.audienceQuery);
    return res.json({
      success: true,
      data: { campaignId: campaign._id, audienceSize, audienceQuery: campaign.audienceQuery },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/campaigns/:id/communications
 * Paginated list of Communication records for a campaign.
 * Supports filtering by status, and shows engagement timestamps.
 */
const getCampaignCommunications = async (req, res, next) => {
  try {
    const { limit, skip, page } = req.pagination;
    const { status, engaged } = req.query;

    const filter = { campaignId: req.params.id };
    if (status) filter.status = status;
    // ?engaged=true → only show records that were opened/read/clicked
    if (engaged === 'true') filter.openedAt = { $ne: null };

    const [comms, total] = await Promise.all([
      Communication.find(filter)
        .populate('customerId', 'name email phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Communication.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: comms,
      pagination: {
        page, limit, total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: skip + comms.length < total,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/campaigns/stats
 * Aggregate dashboard stats across all campaigns.
 * Includes engagement funnel and attribution totals.
 */
const getCampaignStats = async (req, res, next) => {
  try {
    const [overview] = await Campaign.aggregate([
      {
        $group: {
          _id: null,
          totalCampaigns:  { $sum: 1 },
          totalSent:       { $sum: '$stats.sent' },
          totalDelivered:  { $sum: '$stats.delivered' },
          totalFailed:     { $sum: '$stats.failed' },
          totalOpened:     { $sum: '$stats.opened' },
          totalRead:       { $sum: '$stats.read' },
          totalClicked:    { $sum: '$stats.clicked' },
          totalConversions:{ $sum: '$stats.conversions' },
          totalRevenue:    { $sum: '$stats.revenue' },
          avgAudienceSize: { $avg: '$audienceSize' },
        },
      },
    ]);

    const byStatus  = await Campaign.aggregate([{ $group: { _id: '$status',  count: { $sum: 1 } } }]);
    const byChannel = await Campaign.aggregate([{ $group: { _id: '$channel', count: { $sum: 1 } } }]);

    // Channel-level engagement rates
    const channelEngagement = await Campaign.aggregate([
      { $match: { status: 'completed', 'stats.delivered': { $gt: 0 } } },
      {
        $group: {
          _id: '$channel',
          totalDelivered: { $sum: '$stats.delivered' },
          totalOpened:    { $sum: '$stats.opened' },
          totalClicked:   { $sum: '$stats.clicked' },
        },
      },
      {
        $project: {
          channel:     '$_id',
          delivered:   '$totalDelivered',
          openRate:    { $round: [{ $multiply: [{ $divide: ['$totalOpened',  '$totalDelivered'] }, 100] }, 1] },
          clickRate:   { $round: [{ $multiply: [{ $divide: ['$totalClicked', '$totalDelivered'] }, 100] }, 1] },
        },
      },
    ]);

    return res.json({
      success: true,
      data: { overview: overview || {}, byStatus, byChannel, channelEngagement },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/campaigns/:id/clone
 * Clones a campaign as a new draft — copies all fields except
 * status (reset to 'draft'), stats (zeroed), sentAt, completedAt, idempotencyKey.
 * Useful for re-running successful campaigns with tweaks.
 */
const cloneCampaign = async (req, res, next) => {
  try {
    const source = await Campaign.findById(req.params.id).lean();
    if (!source) return next(new AppError('Campaign not found', 404, 'NOT_FOUND'));

    const clonedName = req.body.name || `${source.name} (Copy)`;

    const clone = await Campaign.create({
      name:         clonedName,
      description:  source.description,
      audienceQuery:source.audienceQuery,
      audienceSize: source.audienceSize,
      message:      source.message,
      channel:      source.channel,
      // Reset operational fields
      status:       'draft',
      scheduledAt:  null,
      idempotencyKey: null,
      sentAt:       null,
      completedAt:  null,
      stats: { sent: 0, delivered: 0, failed: 0, opened: 0, read: 0, clicked: 0, conversions: 0, revenue: 0 },
    });

    return res.status(201).json({
      success: true,
      message: `Campaign cloned as "${clonedName}"`,
      data: clone,
      sourceId: source._id,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/campaigns/:id/schedule
 * Schedules a campaign for future delivery.
 * Body: { scheduledAt: ISO datetime string }
 *
 * Only draft campaigns can be scheduled.
 * The background scheduler (scheduler.service.js) polls every 60s
 * and auto-sends campaigns past their scheduledAt time.
 */
const scheduleCampaign = async (req, res, next) => {
  try {
    const { scheduledAt } = req.body;

    if (!scheduledAt) {
      return next(new AppError('scheduledAt (ISO datetime) is required', 400, 'MISSING_FIELDS'));
    }

    const scheduleDate = new Date(scheduledAt);
    if (isNaN(scheduleDate.getTime())) {
      return next(new AppError('scheduledAt must be a valid ISO datetime string', 400, 'INVALID_DATE'));
    }

    if (scheduleDate <= new Date()) {
      return next(new AppError('scheduledAt must be a future date/time', 400, 'PAST_DATE'));
    }

    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return next(new AppError('Campaign not found', 404, 'NOT_FOUND'));

    if (!['draft', 'scheduled'].includes(campaign.status)) {
      return next(
        new AppError(
          `Cannot schedule a campaign with status '${campaign.status}'. Only draft or already-scheduled campaigns can be rescheduled.`,
          409,
          'INVALID_STATUS_FOR_SCHEDULING'
        )
      );
    }

    const updated = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'scheduled', scheduledAt: scheduleDate } },
      { new: true }
    );

    const minutesUntilSend = Math.round((scheduleDate - new Date()) / 60000);
    const humanReadable = minutesUntilSend < 60
      ? `${minutesUntilSend} minute(s) from now`
      : `${Math.round(minutesUntilSend / 60)} hour(s) from now`;

    return res.json({
      success: true,
      message: `Campaign scheduled to send ${humanReadable}`,
      data: {
        campaignId:  updated._id,
        name:        updated.name,
        status:      updated.status,
        scheduledAt: updated.scheduledAt,
        scheduledIn: humanReadable,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/campaigns/:id/schedule
 * Cancels a scheduled campaign — reverts status back to 'draft'.
 */
const unscheduleCampaign = async (req, res, next) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return next(new AppError('Campaign not found', 404, 'NOT_FOUND'));

    if (campaign.status !== 'scheduled') {
      return next(
        new AppError(`Campaign is not scheduled (current status: '${campaign.status}')`, 409, 'NOT_SCHEDULED')
      );
    }

    const updated = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'draft', scheduledAt: null } },
      { new: true }
    );

    return res.json({
      success: true,
      message: 'Campaign schedule cancelled — reverted to draft',
      data: updated,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listCampaigns,
  getCampaign,
  createCampaignHandler,
  sendCampaignHandler,
  previewAudience,
  getCampaignCommunications,
  getCampaignStats,
  cloneCampaign,
  scheduleCampaign,
  unscheduleCampaign,
};
