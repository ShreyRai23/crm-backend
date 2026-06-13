'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/analytics.controller');

/**
 * Analytics Routes
 *
 * GET /api/analytics/overview     — Full dashboard snapshot (all key metrics)
 * GET /api/analytics/revenue      — Revenue trend chart data (12 months)
 * GET /api/analytics/campaigns    — Campaign performance leaderboard
 * GET /api/analytics/customers    — Customer health: spend/activity buckets, churn risk
 */

router.get('/overview',   ctrl.getOverview);
router.get('/revenue',    ctrl.getRevenueTrend);
router.get('/campaigns',  ctrl.getCampaignPerformance);
router.get('/customers',  ctrl.getCustomerHealth);

module.exports = router;
