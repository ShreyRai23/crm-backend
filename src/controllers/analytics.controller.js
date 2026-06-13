'use strict';

/**
 * Analytics Controller
 *
 * Provides comprehensive dashboard metrics for the CRM.
 * All queries are designed to be fast via indexes and aggregations.
 *
 * Endpoints:
 *   GET /api/analytics/overview    — Full dashboard snapshot
 *   GET /api/analytics/revenue     — Revenue trends (12 months)
 *   GET /api/analytics/campaigns   — Campaign performance leaderboard
 *   GET /api/analytics/customers   — Customer health metrics
 */

const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Campaign = require('../models/Campaign');
const Communication = require('../models/Communication');

// ─── Date helpers ─────────────────────────────────────────────────────────────
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const startOfMonth = (monthsBack = 0) => {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack, 1);
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * GET /api/analytics/overview
 * The "command centre" — aggregates all key metrics in a single response.
 * Powers the main dashboard.
 */
const getOverview = async (req, res, next) => {
  try {
    // ── Parallel data fetching (all queries run concurrently) ─────────────────
    const [
      customerStats,
      orderStats,
      campaignStats,
      channelBreakdown,
      topTags,
      recentCampaigns,
      optOutStats,
      engagementOverall,
    ] = await Promise.all([
      // 1. Customer overview
      Customer.aggregate([
        {
          $group: {
            _id: null,
            total:          { $sum: 1 },
            active:         { $sum: { $cond: ['$isActive', 1, 0] } },
            totalSpend:     { $sum: '$totalSpend' },
            avgSpend:       { $avg: '$totalSpend' },
            maxSpend:       { $max: '$totalSpend' },
            newThisMonth:   {
              $sum: {
                $cond: [{ $gte: ['$createdAt', startOfMonth()] }, 1, 0],
              },
            },
            inactive90Days: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$isActive', true] },
                      { $lt: ['$lastVisit', daysAgo(90)] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      // 2. Order overview
      Order.aggregate([
        {
          $group: {
            _id: null,
            totalOrders:      { $sum: 1 },
            totalRevenue:     { $sum: '$amount' },
            avgOrderValue:    { $avg: '$amount' },
            ordersThisMonth:  {
              $sum: { $cond: [{ $gte: ['$purchasedAt', startOfMonth()] }, 1, 0] },
            },
            revenueThisMonth: {
              $sum: {
                $cond: [
                  { $gte: ['$purchasedAt', startOfMonth()] },
                  '$amount',
                  0,
                ],
              },
            },
            revenueLastMonth: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$purchasedAt', startOfMonth(1)] },
                      { $lt:  ['$purchasedAt', startOfMonth(0)] },
                    ],
                  },
                  '$amount',
                  0,
                ],
              },
            },
            attributedOrders:  { $sum: { $cond: [{ $ne: ['$attributedCampaignId', null] }, 1, 0] } },
            attributedRevenue: {
              $sum: {
                $cond: [{ $ne: ['$attributedCampaignId', null] }, '$amount', 0],
              },
            },
          },
        },
      ]),

      // 3. Campaign overview
      Campaign.aggregate([
        {
          $group: {
            _id: null,
            total:            { $sum: 1 },
            completed:        { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            running:          { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } },
            scheduled:        { $sum: { $cond: [{ $eq: ['$status', 'scheduled'] }, 1, 0] } },
            draft:            { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
            totalSent:        { $sum: '$stats.sent' },
            totalDelivered:   { $sum: '$stats.delivered' },
            totalFailed:      { $sum: '$stats.failed' },
            totalOpened:      { $sum: '$stats.opened' },
            totalClicked:     { $sum: '$stats.clicked' },
            totalConversions: { $sum: '$stats.conversions' },
            totalRevenue:     { $sum: '$stats.revenue' },
          },
        },
      ]),

      // 4. Channel breakdown (active customers)
      Customer.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$preferredChannel', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // 5. Top 10 customer tags
      Customer.aggregate([
        { $match: { isActive: true } },
        { $unwind: '$tags' },
        { $group: { _id: '$tags', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // 6. Recent 5 campaigns with performance
      Campaign.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select('name channel status stats audienceSize sentAt completedAt')
        .lean(),

      // 7. Opt-out stats — use $ifNull to handle docs missing optedOutChannels
      Customer.aggregate([
        {
          $group: {
            _id: null,
            totalOptedOut: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ['$optedOutChannels', []] } }, 0] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      // 8. Overall engagement funnel (from Communications)
      Communication.aggregate([
        {
          $group: {
            _id: null,
            totalMessages: { $sum: 1 },
            delivered:     { $sum: { $cond: [{ $in: ['$status', ['delivered', 'opened', 'read', 'clicked']] }, 1, 0] } },
            opened:        { $sum: { $cond: [{ $ne: ['$openedAt',  null] }, 1, 0] } },
            read:          { $sum: { $cond: [{ $ne: ['$readAt',    null] }, 1, 0] } },
            clicked:       { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } },
          },
        },
      ]),
    ]);

    // ── Compute derived metrics ─────────────────────────────────────────────────
    const cs   = customerStats[0] || {};
    const os   = orderStats[0]    || {};
    const camp = campaignStats[0] || {};
    const eng  = engagementOverall[0] || {};

    const revenueGrowth = os.revenueLastMonth > 0
      ? +(((os.revenueThisMonth - os.revenueLastMonth) / os.revenueLastMonth) * 100).toFixed(1)
      : null;

    const overallDeliveryRate = eng.totalMessages > 0
      ? +((eng.delivered / eng.totalMessages) * 100).toFixed(1)
      : 0;
    const overallOpenRate = eng.delivered > 0
      ? +((eng.opened / eng.delivered) * 100).toFixed(1)
      : 0;
    const overallClickRate = eng.delivered > 0
      ? +((eng.clicked / eng.delivered) * 100).toFixed(1)
      : 0;

    return res.json({
      success: true,
      data: {
        customers: {
          total:          cs.total          || 0,
          active:         cs.active         || 0,
          newThisMonth:   cs.newThisMonth   || 0,
          inactive90Days: cs.inactive90Days || 0,
          totalLifetimeRevenue: cs.totalSpend || 0,
          avgLifetimeSpend:     +(cs.avgSpend || 0).toFixed(2),
          maxLifetimeSpend:     cs.maxSpend   || 0,
          totalOptedOut:  (optOutStats[0] || {}).totalOptedOut || 0,
          channelDistribution: channelBreakdown,
          topTags,
        },
        orders: {
          total:            os.totalOrders      || 0,
          totalRevenue:     os.totalRevenue     || 0,
          avgOrderValue:    +(os.avgOrderValue  || 0).toFixed(2),
          ordersThisMonth:  os.ordersThisMonth  || 0,
          revenueThisMonth: os.revenueThisMonth || 0,
          revenueLastMonth: os.revenueLastMonth || 0,
          revenueGrowth,
          attributedOrders:  os.attributedOrders  || 0,
          attributedRevenue: os.attributedRevenue || 0,
        },
        campaigns: {
          total:      camp.total      || 0,
          completed:  camp.completed  || 0,
          running:    camp.running    || 0,
          scheduled:  camp.scheduled  || 0,
          draft:      camp.draft      || 0,
          totalSent:        camp.totalSent        || 0,
          totalDelivered:   camp.totalDelivered   || 0,
          totalFailed:      camp.totalFailed      || 0,
          totalOpened:      camp.totalOpened      || 0,
          totalClicked:     camp.totalClicked     || 0,
          totalConversions: camp.totalConversions || 0,
          attributedRevenue:camp.totalRevenue     || 0,
        },
        engagementFunnel: {
          totalMessages:  eng.totalMessages || 0,
          delivered:      eng.delivered     || 0,
          opened:         eng.opened        || 0,
          read:           eng.read          || 0,
          clicked:        eng.clicked       || 0,
          overallDeliveryRate,
          overallOpenRate,
          overallClickRate,
        },
        recentCampaigns,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/analytics/revenue
 * Revenue trend data for the past 12 months.
 * Powers the revenue chart on the dashboard.
 */
const getRevenueTrend = async (req, res, next) => {
  try {
    const months = parseInt(req.query.months, 10) || 12;
    const startDate = startOfMonth(months - 1);

    const revenueByMonth = await Order.aggregate([
      { $match: { purchasedAt: { $gte: startDate } } },
      {
        $group: {
          _id: {
            year:  { $year: '$purchasedAt' },
            month: { $month: '$purchasedAt' },
          },
          revenue:   { $sum: '$amount' },
          orders:    { $sum: 1 },
          avgOrder:  { $avg: '$amount' },
          attributed:{ $sum: { $cond: [{ $ne: ['$attributedCampaignId', null] }, '$amount', 0] } },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      {
        $project: {
          _id: 0,
          year:      '$_id.year',
          month:     '$_id.month',
          label: {
            $concat: [
              { $arrayElemAt: [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
                               '$_id.month'] },
              ' ',
              { $toString: '$_id.year' },
            ],
          },
          revenue:    { $round: ['$revenue', 0] },
          orders:     1,
          avgOrder:   { $round: ['$avgOrder', 0] },
          attributed: { $round: ['$attributed', 0] },
        },
      },
    ]);

    return res.json({
      success: true,
      data: revenueByMonth,
      meta: { months, startDate },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/analytics/campaigns
 * Campaign performance leaderboard — sorted by engagement rate.
 * Shows the best and worst performing campaigns.
 */
const getCampaignPerformance = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;

    const campaigns = await Campaign.aggregate([
      { $match: { status: 'completed', 'stats.delivered': { $gt: 0 } } },
      {
        $project: {
          name:         1,
          channel:      1,
          audienceSize: 1,
          sentAt:       1,
          completedAt:  1,
          stats:        1,
          deliveryRate: {
            $round: [{
              $multiply: [
                { $divide: ['$stats.delivered', { $max: [{ $add: ['$stats.delivered', '$stats.failed'] }, 1] }] },
                100,
              ],
            }, 1],
          },
          openRate: {
            $round: [{
              $multiply: [
                { $divide: ['$stats.opened', { $max: ['$stats.delivered', 1] }] },
                100,
              ],
            }, 1],
          },
          clickRate: {
            $round: [{
              $multiply: [
                { $divide: ['$stats.clicked', { $max: ['$stats.delivered', 1] }] },
                100,
              ],
            }, 1],
          },
        },
      },
      { $sort: { openRate: -1 } },
      { $limit: limit },
    ]);

    return res.json({
      success: true,
      data: campaigns,
      meta: { limit, sortedBy: 'openRate' },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/analytics/customers
 * Customer health metrics — spend distribution, activity, churn risk.
 */
const getCustomerHealth = async (req, res, next) => {
  try {
    const [spendBuckets, activityBuckets, cityBreakdown, churnRisk] = await Promise.all([
      // Spend distribution buckets
      Customer.aggregate([
        { $match: { isActive: true } },
        {
          $bucket: {
            groupBy: '$totalSpend',
            boundaries: [0, 500, 2000, 5000, 10000, 25000, 50000],
            default: '50000+',
            output: {
              count:      { $sum: 1 },
              totalSpend: { $sum: '$totalSpend' },
              avgSpend:   { $avg: '$totalSpend' },
            },
          },
        },
      ]),

      // Activity distribution
      Customer.aggregate([
        { $match: { isActive: true, lastVisit: { $ne: null } } },
        {
          $bucket: {
            groupBy: {
              $divide: [
                { $subtract: [new Date(), '$lastVisit'] },
                1000 * 60 * 60 * 24, // Convert ms to days
              ],
            },
            boundaries: [0, 7, 30, 60, 90, 180],
            default: '180+ days',
            output: {
              count:    { $sum: 1 },
              avgSpend: { $avg: '$totalSpend' },
            },
          },
        },
      ]),

      // Top 10 cities
      Customer.aggregate([
        { $match: { isActive: true, city: { $ne: null } } },
        { $group: { _id: '$city', count: { $sum: 1 }, totalSpend: { $sum: '$totalSpend' } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // Churn risk: active customers, last visited 60-90 days ago, never had a campaign
      Customer.aggregate([
        {
          $match: {
            isActive: true,
            lastVisit: {
              $gte: daysAgo(90),
              $lt:  daysAgo(60),
            },
          },
        },
        {
          $group: {
            _id: null,
            count:      { $sum: 1 },
            avgSpend:   { $avg: '$totalSpend' },
            totalSpend: { $sum: '$totalSpend' },
          },
        },
      ]),
    ]);

    return res.json({
      success: true,
      data: {
        spendDistribution: spendBuckets,
        activityDistribution: activityBuckets,
        topCities: cityBreakdown,
        churnRisk: churnRisk[0] || { count: 0, avgSpend: 0, totalSpend: 0 },
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getOverview,
  getRevenueTrend,
  getCampaignPerformance,
  getCustomerHealth,
};
