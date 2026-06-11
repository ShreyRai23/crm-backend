'use strict';

const Order = require('../models/Order');
const Customer = require('../models/Customer');
const Campaign = require('../models/Campaign');
const Communication = require('../models/Communication');
const { AppError } = require('../middleware/errorHandler');

const ATTRIBUTION_WINDOW_DAYS = 7; // Last-touch attribution window

/**
 * GET /api/orders
 * Offset-based pagination with filters.
 * Query params: limit, page, customerId, status, minAmount, maxAmount
 */
const listOrders = async (req, res, next) => {
  try {
    const { limit, skip, page } = req.pagination;
    const { customerId, status, minAmount, maxAmount } = req.query;

    const filter = {};
    if (customerId) filter.customerId = customerId;
    if (status) filter.status = status;
    if (minAmount || maxAmount) {
      filter.amount = {};
      if (minAmount) filter.amount.$gte = parseFloat(minAmount);
      if (maxAmount) filter.amount.$lte = parseFloat(maxAmount);
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('customerId', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: skip + orders.length < total,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/orders/:id
 */
const getOrder = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customerId', 'name email phone')
      .lean();

    if (!order) {
      return next(new AppError('Order not found', 404, 'NOT_FOUND'));
    }

    return res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/orders
 * Creates an order and updates the customer's totalSpend and visitCount.
 */
const createOrder = async (req, res, next) => {
  try {
    const { customerId, amount, items, status, purchasedAt } = req.body;

    // Verify customer exists
    const customer = await Customer.findById(customerId);
    if (!customer) {
      return next(new AppError('Customer not found', 404, 'NOT_FOUND'));
    }

    const order = await Order.create({
      customerId,
      amount,
      items: items || [],
      status: status || 'delivered',
      purchasedAt: purchasedAt ? new Date(purchasedAt) : new Date(),
    });

    // Atomically update the customer's aggregate spend and visit count
    await Customer.findByIdAndUpdate(customerId, {
      $inc: { totalSpend: amount, visitCount: 1 },
      $set: { lastVisit: new Date() },
    });

    return res.status(201).json({
      success: true,
      data: order,
      message: 'Order created successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/orders/stats
 * Order statistics for the dashboard.
 */
const getOrderStats = async (req, res, next) => {
  try {
    const [stats] = await Order.aggregate([
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$amount' },
          avgOrderValue: { $avg: '$amount' },
          maxOrderValue: { $max: '$amount' },
        },
      },
    ]);

    const statusBreakdown = await Order.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$amount' } } },
      { $sort: { count: -1 } },
    ]);

    // Revenue by month (last 12 months)
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const revenueByMonth = await Order.aggregate([
      { $match: { purchasedAt: { $gte: twelveMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: '$purchasedAt' },
            month: { $month: '$purchasedAt' },
          },
          revenue: { $sum: '$amount' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    return res.json({
      success: true,
      data: { overview: stats || {}, statusBreakdown, revenueByMonth },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/orders/:id/attribute
 * Attributes an order to a specific Campaign (last-touch attribution).
 *
 * This answers the PDF requirement:
 * "order came because of this communication"
 *
 * Auto-attribution logic:
 *   If campaignId is provided, we find the Communication sent to the order's
 *   customer for that campaign (within the attribution window).
 *   If that communication exists, we link the order to both the campaign
 *   AND the specific communication.
 *
 * Body: { campaignId, communicationId? }
 */
const attributeOrder = async (req, res, next) => {
  try {
    const { campaignId, communicationId } = req.body;

    if (!campaignId) {
      return next(new AppError('campaignId is required for attribution', 400, 'MISSING_FIELDS'));
    }

    const order = await Order.findById(req.params.id);
    if (!order) return next(new AppError('Order not found', 404, 'NOT_FOUND'));

    // Prevent re-attribution (idempotent)
    if (order.attributedCampaignId) {
      return res.json({
        success: true,
        message: 'Order already attributed — no change made',
        data: order,
        skipped: true,
      });
    }

    // Verify campaign exists
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) return next(new AppError('Campaign not found', 404, 'NOT_FOUND'));

    // Auto-find the Communication if not explicitly provided
    let resolvedCommunicationId = communicationId || null;
    if (!resolvedCommunicationId) {
      // Find the communication sent to this customer for this campaign
      // within the attribution window
      const windowStart = new Date(order.purchasedAt);
      windowStart.setDate(windowStart.getDate() - ATTRIBUTION_WINDOW_DAYS);

      const comm = await Communication.findOne({
        campaignId,
        customerId: order.customerId,
        status: { $in: ['delivered', 'opened', 'read', 'clicked'] },
        deliveredAt: { $gte: windowStart, $lte: order.purchasedAt },
      }).sort({ deliveredAt: -1 });

      if (comm) resolvedCommunicationId = comm._id;
    }

    // Update the order with attribution data
    const updatedOrder = await Order.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          attributedCampaignId:      campaignId,
          attributedCommunicationId: resolvedCommunicationId,
          attributedAt:              new Date(),
          attributionWindowDays:     ATTRIBUTION_WINDOW_DAYS,
        },
      },
      { new: true }
    );

    // Increment campaign conversion stats atomically
    await Campaign.findByIdAndUpdate(campaignId, {
      $inc: {
        'stats.conversions': 1,
        'stats.revenue':     order.amount,
      },
    });

    return res.json({
      success: true,
      message: `Order attributed to campaign "${campaign.name}"`,
      data: {
        orderId:               updatedOrder._id,
        orderAmount:           updatedOrder.amount,
        attributedCampaignId:  campaignId,
        attributedCommunicationId: resolvedCommunicationId,
        attributedAt:          updatedOrder.attributedAt,
        attributionWindowDays: ATTRIBUTION_WINDOW_DAYS,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { listOrders, getOrder, createOrder, getOrderStats, attributeOrder };
