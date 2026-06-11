'use strict';

const Customer = require('../models/Customer');
const Order = require('../models/Order');
const { AppError } = require('../middleware/errorHandler');

/**
 * GET /api/customers
 * Cursor-based pagination using _id as cursor.
 * Query params: limit, cursor (last _id from previous page), search, tags, channel
 */
const listCustomers = async (req, res, next) => {
  try {
    const { limit, cursor } = req.pagination;
    const { search, tags, channel, minSpend, maxSpend, isActive } = req.query;

    // Build filter
    const filter = {};

    // Cursor pagination: fetch records after the cursor _id
    if (cursor) {
      filter._id = { $gt: cursor };
    }

    // isActive filter (default: true)
    filter.isActive = isActive === 'false' ? false : true;

    // Full-text search on name and email
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    // Tag filter (comma-separated)
    if (tags) {
      filter.tags = { $in: tags.split(',').map((t) => t.trim()) };
    }

    // Channel filter
    if (channel) {
      filter.preferredChannel = channel;
    }

    // Spend range filter
    if (minSpend || maxSpend) {
      filter.totalSpend = {};
      if (minSpend) filter.totalSpend.$gte = parseFloat(minSpend);
      if (maxSpend) filter.totalSpend.$lte = parseFloat(maxSpend);
    }

    const customers = await Customer.find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1) // Fetch one extra to detect if there's a next page
      .lean();

    const hasNextPage = customers.length > limit;
    const data = hasNextPage ? customers.slice(0, limit) : customers;
    const nextCursor = hasNextPage ? data[data.length - 1]._id : null;

    return res.json({
      success: true,
      data,
      pagination: {
        limit,
        cursor: nextCursor,
        hasNextPage,
        count: data.length,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/:id
 * Returns a single customer with their recent orders.
 */
const getCustomer = async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id).lean();
    if (!customer) {
      return next(new AppError('Customer not found', 404, 'NOT_FOUND'));
    }

    // Fetch recent 10 orders
    const recentOrders = await Order.find({ customerId: customer._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return res.json({
      success: true,
      data: { ...customer, recentOrders },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/customers
 * Create a new customer.
 */
const createCustomer = async (req, res, next) => {
  try {
    const { name, email, phone, tags, preferredChannel, city, country } = req.body;

    const customer = await Customer.create({
      name,
      email,
      phone,
      tags: tags || [],
      preferredChannel: preferredChannel || 'email',
      city,
      country,
    });

    return res.status(201).json({
      success: true,
      data: customer,
      message: 'Customer created successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/customers/:id
 * Update a customer's details.
 */
const updateCustomer = async (req, res, next) => {
  try {
    const allowedUpdates = ['name', 'phone', 'tags', 'preferredChannel', 'city', 'country', 'isActive'];
    const updates = {};
    allowedUpdates.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!customer) {
      return next(new AppError('Customer not found', 404, 'NOT_FOUND'));
    }

    return res.json({
      success: true,
      data: customer,
      message: 'Customer updated successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/customers/:id
 * Soft delete — sets isActive to false.
 */
const deleteCustomer = async (req, res, next) => {
  try {
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );

    if (!customer) {
      return next(new AppError('Customer not found', 404, 'NOT_FOUND'));
    }

    return res.json({
      success: true,
      message: 'Customer deactivated successfully',
      data: { id: customer._id, isActive: false },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/stats
 * Aggregate statistics for dashboard.
 */
const getCustomerStats = async (req, res, next) => {
  try {
    const [stats] = await Customer.aggregate([
      {
        $group: {
          _id: null,
          totalCustomers: { $sum: 1 },
          activeCustomers: { $sum: { $cond: ['$isActive', 1, 0] } },
          totalSpend: { $sum: '$totalSpend' },
          avgSpend: { $avg: '$totalSpend' },
          avgVisits: { $avg: '$visitCount' },
        },
      },
    ]);

    const channelBreakdown = await Customer.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$preferredChannel', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return res.json({
      success: true,
      data: {
        overview: stats || {},
        channelBreakdown,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/customers/:id/opt-out
 * Opts a customer out of one or more channels.
 * Body: { channels: ["whatsapp", "email", "sms", "rcs"] }
 *
 * Idempotent: if already opted out of a channel, no duplicate is added.
 * GDPR / DPDP compliant: campaign.service.js enforces this at send time.
 */
const optOut = async (req, res, next) => {
  try {
    const { channels } = req.body;
    const VALID_CHANNELS = ['whatsapp', 'email', 'sms', 'rcs'];

    if (!channels || !Array.isArray(channels) || channels.length === 0) {
      return next(new AppError('channels must be a non-empty array', 400, 'MISSING_FIELDS'));
    }

    const invalidChannels = channels.filter((c) => !VALID_CHANNELS.includes(c));
    if (invalidChannels.length > 0) {
      return next(
        new AppError(
          `Invalid channels: ${invalidChannels.join(', ')}. Valid: ${VALID_CHANNELS.join(', ')}`,
          400,
          'INVALID_CHANNEL'
        )
      );
    }

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      {
        // $addToSet prevents duplicates atomically
        $addToSet: { optedOutChannels: { $each: channels } },
        $set: { optedOutAt: new Date() },
      },
      { new: true }
    );

    if (!customer) return next(new AppError('Customer not found', 404, 'NOT_FOUND'));

    return res.json({
      success: true,
      message: `Customer opted out of: ${channels.join(', ')}`,
      data: {
        customerId:        customer._id,
        optedOutChannels:  customer.optedOutChannels,
        optedOutAt:        customer.optedOutAt,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/customers/:id/opt-in
 * Re-subscribes a customer to one or more channels.
 * Body: { channels: ["whatsapp", "email", "sms", "rcs"] }
 *
 * Idempotent: if the customer wasn't opted out, this is a no-op for that channel.
 */
const optIn = async (req, res, next) => {
  try {
    const { channels } = req.body;
    const VALID_CHANNELS = ['whatsapp', 'email', 'sms', 'rcs'];

    if (!channels || !Array.isArray(channels) || channels.length === 0) {
      return next(new AppError('channels must be a non-empty array', 400, 'MISSING_FIELDS'));
    }

    const invalidChannels = channels.filter((c) => !VALID_CHANNELS.includes(c));
    if (invalidChannels.length > 0) {
      return next(
        new AppError(
          `Invalid channels: ${invalidChannels.join(', ')}. Valid: ${VALID_CHANNELS.join(', ')}`,
          400,
          'INVALID_CHANNEL'
        )
      );
    }

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      {
        // $pull removes the channel from optedOutChannels array
        $pull: { optedOutChannels: { $in: channels } },
      },
      { new: true }
    );

    if (!customer) return next(new AppError('Customer not found', 404, 'NOT_FOUND'));

    // Clear optedOutAt if no channels remain opted-out
    if (customer.optedOutChannels.length === 0) {
      await Customer.findByIdAndUpdate(req.params.id, { $set: { optedOutAt: null } });
      customer.optedOutAt = null;
    }

    return res.json({
      success: true,
      message: `Customer opted back in to: ${channels.join(', ')}`,
      data: {
        customerId:       customer._id,
        optedOutChannels: customer.optedOutChannels,
        optedOutAt:       customer.optedOutAt,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/:id/campaign-history
 * Returns all campaigns this customer was part of, with engagement info.
 * Useful for the customer detail page in the frontend.
 */
const getCampaignHistory = async (req, res, next) => {
  try {
    const Communication = require('../models/Communication');

    const history = await Communication.find({ customerId: req.params.id })
      .populate('campaignId', 'name channel status sentAt')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.json({
      success: true,
      data: history,
      meta: { total: history.length },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerStats,
  optOut,
  optIn,
  getCampaignHistory,
};
