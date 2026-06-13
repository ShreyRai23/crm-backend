'use strict';

const Customer = require('../models/Customer');
const Order = require('../models/Order');
const {
  nlToMongodbPipeline,
  generateCampaignContent,
  generateCampaignSuggestions,
} = require('../services/gemini.service');
const { previewAudienceSize } = require('../services/campaign.service');
const SEGMENT_PRESETS = require('../data/segmentPresets');
const { AppError } = require('../middleware/errorHandler');

/**
 * POST /api/ai/query
 *
 * Accepts a natural language prompt from a marketer,
 * generates a safe MongoDB aggregation pipeline using Gemini,
 * executes it against the customers collection, and returns results.
 *
 * Body: { prompt: string, execute?: boolean, limit?: number }
 */
const nlQuery = async (req, res, next) => {
  try {
    const { prompt, execute = true, limit = 100 } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
      return next(new AppError('Prompt must be a non-empty string (min 5 characters)', 400, 'INVALID_PROMPT'));
    }

    // Generate and validate the pipeline
    const { pipeline, explanation } = await nlToMongodbPipeline(prompt.trim());

    let results = null;
    let count = 0;

    if (execute) {
      // Enforce a user-defined result limit on top of the pipeline's own limit
      const cappedPipeline = [
        ...pipeline,
        { $limit: Math.min(parseInt(limit, 10) || 100, 500) },
      ];

      results = await Customer.aggregate(cappedPipeline);
      count = results.length;
    }

    return res.json({
      success: true,
      data: {
        prompt,
        explanation,
        pipeline,
        results: execute ? results : null,
        count,
        executed: execute,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/ai/generate-content
 *
 * Generates channel-personalized campaign messaging using Gemini.
 *
 * Body: {
 *   audienceDescription: string,
 *   channel: "whatsapp" | "email" | "sms" | "rcs",
 *   campaignGoal: string,
 *   brandName?: string
 * }
 */
const generateContent = async (req, res, next) => {
  try {
    const { audienceDescription, channel, campaignGoal, brandName } = req.body;

    if (!audienceDescription) {
      return next(new AppError('audienceDescription is required', 400, 'MISSING_FIELDS'));
    }
    if (!channel || !['whatsapp', 'email', 'sms', 'rcs'].includes(channel)) {
      return next(new AppError('channel must be one of: whatsapp, email, sms, rcs', 400, 'INVALID_CHANNEL'));
    }
    if (!campaignGoal) {
      return next(new AppError('campaignGoal is required', 400, 'MISSING_FIELDS'));
    }

    const content = await generateCampaignContent({
      audienceDescription,
      channel,
      campaignGoal,
      brandName: brandName || 'Our Brand',
    });

    return res.json({
      success: true,
      data: content,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/ai/query-and-generate
 *
 * Power endpoint: accepts a NL audience query + campaign goal,
 * returns both the audience pipeline AND generated content in one call.
 * Useful for the campaign creation wizard.
 *
 * Body: { audiencePrompt: string, channel: string, campaignGoal: string, brandName?: string }
 */
const queryAndGenerate = async (req, res, next) => {
  try {
    const { audiencePrompt, channel, campaignGoal, brandName } = req.body;

    if (!audiencePrompt || !channel || !campaignGoal) {
      return next(
        new AppError('audiencePrompt, channel, and campaignGoal are required', 400, 'MISSING_FIELDS')
      );
    }

    // Run both AI operations in parallel
    const [pipelineResult, contentResult] = await Promise.all([
      nlToMongodbPipeline(audiencePrompt.trim()),
      generateCampaignContent({
        audienceDescription: audiencePrompt,
        channel,
        campaignGoal,
        brandName: brandName || 'Our Brand',
      }),
    ]);

    // Get audience size for the generated pipeline
    let audienceSize = 0;
    try {
      const countResult = await Customer.aggregate([
        ...pipelineResult.pipeline,
        { $count: 'total' },
      ]);
      audienceSize = countResult.length > 0 ? countResult[0].total : 0;
    } catch {
      // Non-critical
    }

    return res.json({
      success: true,
      data: {
        audience: {
          pipeline: pipelineResult.pipeline,
          explanation: pipelineResult.explanation,
          estimatedSize: audienceSize,
        },
        content: contentResult,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/ai/suggestions
 *
 * AI-powered campaign suggestions engine.
 *
 * Reads real aggregate data from the database, feeds it to Gemini as context,
 * and returns 3 data-driven, ready-to-use campaign suggestions — each with
 * a pre-built audience query, suggested channel, rationale, and audience size.
 *
 * This is the "wow" feature: the AI acts like an expert CRM strategist
 * by analyzing your actual customer base patterns.
 *
 * Query params:
 *   count?: number (default 3, max 5) — how many suggestions to generate
 */
const getSuggestions = async (req, res, next) => {
  try {
    // ── Step 1: Gather real database context for Gemini ─────────────────────
    const [
      customerAggregate,
      tagFrequency,
      channelDistribution,
      orderAggregate,
      highValueThreshold,
      inactiveCount,
      newCustomerCount,
    ] = await Promise.all([
      // Overall customer stats
      Customer.aggregate([
        {
          $group: {
            _id: null,
            totalCustomers: { $sum: 1 },
            activeCustomers: { $sum: { $cond: ['$isActive', 1, 0] } },
            avgSpend: { $avg: '$totalSpend' },
          },
        },
      ]),

      // Tag frequency (top 10 most common tags)
      Customer.aggregate([
        { $match: { isActive: true } },
        { $unwind: '$tags' },
        { $group: { _id: '$tags', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // Channel distribution
      Customer.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$preferredChannel', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Revenue this month and last month
      Order.aggregate([
        {
          $group: {
            _id: null,
            revenueThisMonth: {
              $sum: {
                $cond: [
                  {
                    $gte: ['$purchasedAt', new Date(new Date().getFullYear(), new Date().getMonth(), 1)],
                  },
                  '$amount',
                  0,
                ],
              },
            },
            revenuePrevMonth: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $gte: [
                          '$purchasedAt',
                          new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1),
                        ],
                      },
                      {
                        $lt: [
                          '$purchasedAt',
                          new Date(new Date().getFullYear(), new Date().getMonth(), 1),
                        ],
                      },
                    ],
                  },
                  '$amount',
                  0,
                ],
              },
            },
          },
        },
      ]),

      // High-value threshold: 80th percentile spend (top 20%)
      Customer.aggregate([
        { $match: { isActive: true, totalSpend: { $gt: 0 } } },
        { $sort: { totalSpend: -1 } },
        {
          $group: {
            _id: null,
            spends: { $push: '$totalSpend' },
            count:  { $sum: 1 },
          },
        },
        {
          $project: {
            p80Index: { $floor: { $multiply: ['$count', 0.2] } },
            spends: 1,
          },
        },
        {
          $project: {
            threshold: { $arrayElemAt: ['$spends', '$p80Index'] },
          },
        },
      ]),

      // Count of inactive customers (90+ days)
      Customer.countDocuments({
        isActive: true,
        lastVisit: { $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      }),

      // New customers this month
      Customer.countDocuments({
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      }),
    ]);

    // Build context object for Gemini
    const dbContext = {
      totalCustomers:     (customerAggregate[0] || {}).totalCustomers  || 0,
      activeCustomers:    (customerAggregate[0] || {}).activeCustomers || 0,
      avgSpend:           (customerAggregate[0] || {}).avgSpend        || 0,
      highValueThreshold: (highValueThreshold[0] || {}).threshold      || 5000,
      inactiveCount,
      newCustomerCount,
      tagFrequency,
      channelDistribution: channelDistribution.reduce((acc, c) => {
        acc[c._id] = c.count;
        return acc;
      }, {}),
      revenueThisMonth: (orderAggregate[0] || {}).revenueThisMonth || 0,
      revenuePrevMonth: (orderAggregate[0] || {}).revenuePrevMonth || 0,
    };

    // ── Step 2: Generate suggestions with Gemini ─────────────────────────────
    const suggestions = await generateCampaignSuggestions(dbContext);

    // ── Step 3: Compute actual audience size for each suggestion ─────────────
    const enrichedSuggestions = await Promise.all(
      suggestions.map(async (suggestion) => {
        let audienceSize = 0;
        if (suggestion.audienceQuery && suggestion.audienceQuery.length > 0) {
          try {
            audienceSize = await previewAudienceSize(suggestion.audienceQuery);
          } catch {
            // Non-critical — leave at 0 if pipeline is invalid
          }
        }
        return { ...suggestion, audienceSize };
      })
    );

    return res.json({
      success: true,
      data: {
        suggestions: enrichedSuggestions,
        generatedAt: new Date().toISOString(),
        basedOn: {
          totalCustomers:   dbContext.totalCustomers,
          activeCustomers:  dbContext.activeCustomers,
          inactiveCount:    dbContext.inactiveCount,
          newCustomerCount: dbContext.newCustomerCount,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/ai/segments/presets
 *
 * Returns the full pre-built segment preset library.
 * Each preset includes a ready-to-use MongoDB pipeline and metadata.
 */
const getSegmentPresets = async (req, res, next) => {
  try {
    const { category } = req.query;

    let presets = SEGMENT_PRESETS;
    if (category) {
      presets = presets.filter((p) => p.category === category);
    }

    return res.json({
      success: true,
      data: presets,
      meta: { total: presets.length },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/ai/segments/presets/:id/preview
 *
 * Executes a specific preset pipeline against the live database
 * and returns the audience count + sample customers.
 *
 * Params: id — the preset slug (e.g. "high-value-vip")
 */
const previewSegmentPreset = async (req, res, next) => {
  try {
    const preset = SEGMENT_PRESETS.find((p) => p.id === req.params.id);
    if (!preset) {
      return next(new AppError(`Segment preset '${req.params.id}' not found`, 404, 'NOT_FOUND'));
    }

    // Dates in preset pipelines are computed at require-time, so they're always fresh
    const [countResult, sampleCustomers] = await Promise.all([
      Customer.aggregate([...preset.pipeline, { $count: 'total' }]),
      Customer.aggregate([
        ...preset.pipeline,
        { $limit: 5 },
        { $project: { name: 1, email: 1, totalSpend: 1, lastVisit: 1, tags: 1, preferredChannel: 1 } },
      ]),
    ]);

    const audienceSize = countResult.length > 0 ? countResult[0].total : 0;

    return res.json({
      success: true,
      data: {
        preset: {
          id:               preset.id,
          name:             preset.name,
          description:      preset.description,
          category:         preset.category,
          suggestedChannel: preset.suggestedChannel,
          pipeline:         preset.pipeline,
        },
        audienceSize,
        sample: sampleCustomers,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  nlQuery,
  generateContent,
  queryAndGenerate,
  getSuggestions,
  getSegmentPresets,
  previewSegmentPreset,
};
