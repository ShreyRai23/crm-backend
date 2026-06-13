'use strict';

/**
 * Segment Presets
 *
 * A curated library of pre-built, named audience segments.
 * These are validated MongoDB aggregation pipelines with human-readable
 * metadata. Designed to give marketers a one-click starting point
 * without needing to write queries or use the AI builder.
 *
 * Each preset includes:
 *   id:          Unique slug identifier
 *   name:        Human-readable segment name
 *   description: What this segment targets and why it's valuable
 *   category:    "retention" | "growth" | "loyalty" | "winback" | "seasonal"
 *   suggestedChannel: Best performing channel for this segment type
 *   pipeline:    MongoDB aggregation pipeline for the 'customers' collection
 *   tags:        Searchable tags for the UI
 */
const SEGMENT_PRESETS = [
  {
    id: 'high-value-vip',
    name: 'High-Value VIPs',
    description: 'Top 20% of customers by total lifetime spend. Prime audience for exclusive offers and early access.',
    category: 'loyalty',
    suggestedChannel: 'whatsapp',
    tags: ['vip', 'spend', 'loyalty', 'premium'],
    pipeline: [
      { $match: { isActive: true, totalSpend: { $gte: 10000 } } },
      { $sort: { totalSpend: -1 } },
      { $limit: 500 },
    ],
  },
  {
    id: 'inactive-90-days',
    name: 'Dormant Customers (90+ Days)',
    description: 'Customers who haven\'t visited in over 90 days. Classic win-back target with high recovery potential.',
    category: 'winback',
    suggestedChannel: 'email',
    tags: ['inactive', 'winback', 'churn', 'retention'],
    pipeline: [
      {
        $match: {
          isActive: true,
          lastVisit: { $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
        },
      },
      { $sort: { totalSpend: -1 } }, // Prioritize by value
      { $limit: 500 },
    ],
  },
  {
    id: 'new-30-days',
    name: 'New Customers (Last 30 Days)',
    description: 'Customers who joined in the past month. Best time to establish loyalty before they churn.',
    category: 'growth',
    suggestedChannel: 'email',
    tags: ['new', 'onboarding', 'welcome', 'first-order'],
    pipeline: [
      {
        $match: {
          isActive: true,
          createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: 500 },
    ],
  },
  {
    id: 'at-risk-moderate-spenders',
    name: 'At-Risk Moderate Spenders',
    description: 'Mid-tier spenders (₹2,000–₹10,000) who haven\'t visited in 45+ days. High LTV recovery potential.',
    category: 'retention',
    suggestedChannel: 'whatsapp',
    tags: ['at-risk', 'mid-tier', 'retention', 'churn-prevention'],
    pipeline: [
      {
        $match: {
          isActive: true,
          totalSpend: { $gte: 2000, $lte: 10000 },
          lastVisit: { $lt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: 500 },
    ],
  },
  {
    id: 'frequent-buyers',
    name: 'Frequent Buyers',
    description: 'Customers with 5+ visits. These are your most engaged shoppers — reward their loyalty.',
    category: 'loyalty',
    suggestedChannel: 'whatsapp',
    tags: ['frequent', 'loyal', 'engaged', 'high-visit'],
    pipeline: [
      { $match: { isActive: true, visitCount: { $gte: 5 } } },
      { $sort: { visitCount: -1 } },
      { $limit: 500 },
    ],
  },
  {
    id: 'one-time-buyers',
    name: 'One-Time Buyers',
    description: 'Customers who\'ve purchased exactly once. Converting them to repeat buyers is 5x cheaper than new acquisition.',
    category: 'retention',
    suggestedChannel: 'sms',
    tags: ['one-time', 'conversion', 'second-purchase', 'retention'],
    pipeline: [
      { $match: { isActive: true, visitCount: 1 } },
      { $sort: { createdAt: -1 } },
      { $limit: 500 },
    ],
  },
  {
    id: 'high-value-inactive',
    name: 'High-Value But Inactive',
    description: 'VIP customers (₹5,000+ spend) who haven\'t visited in 60+ days. Highest priority win-back segment.',
    category: 'winback',
    suggestedChannel: 'whatsapp',
    tags: ['vip', 'inactive', 'high-value', 'winback', 'priority'],
    pipeline: [
      {
        $match: {
          isActive: true,
          totalSpend: { $gte: 5000 },
          lastVisit: { $lt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: 500 },
    ],
  },
  {
    id: 'mumbai-delhi-customers',
    name: 'Metro City Customers',
    description: 'Customers in Mumbai and Delhi — highest purchasing power cities in India.',
    category: 'growth',
    suggestedChannel: 'rcs',
    tags: ['metro', 'location', 'city', 'india'],
    pipeline: [
      {
        $match: {
          isActive: true,
          city: { $in: ['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai'] },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: 500 },
    ],
  },
  {
    id: 'discount-seekers',
    name: 'Discount Seekers',
    description: 'Customers tagged as "discount-seeker". Respond best to limited-time offers and flash sales.',
    category: 'seasonal',
    suggestedChannel: 'sms',
    tags: ['discount', 'sale', 'price-sensitive', 'flash-sale'],
    pipeline: [
      { $match: { isActive: true, tags: { $in: ['discount-seeker', 'discount'] } } },
      { $sort: { totalSpend: -1 } },
      { $limit: 500 },
    ],
  },
  {
    id: 'recently-active-low-spend',
    name: 'Active But Low Spend',
    description: 'Customers active in last 30 days but total spend under ₹1,000. Upsell opportunity before they churn.',
    category: 'growth',
    suggestedChannel: 'email',
    tags: ['active', 'low-spend', 'upsell', 'growth'],
    pipeline: [
      {
        $match: {
          isActive: true,
          totalSpend: { $lt: 1000 },
          lastVisit: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: 500 },
    ],
  },
];

module.exports = SEGMENT_PRESETS;
