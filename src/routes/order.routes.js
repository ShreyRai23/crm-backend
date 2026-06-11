'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/order.controller');
const { parsePagination, validateObjectId, requireFields } = require('../middleware/validate');

// GET /api/orders/stats
router.get('/stats', ctrl.getOrderStats);

// GET /api/orders
router.get('/', parsePagination, ctrl.listOrders);

// GET /api/orders/:id
router.get('/:id', validateObjectId(), ctrl.getOrder);

// POST /api/orders
router.post('/', requireFields(['customerId', 'amount']), ctrl.createOrder);

// POST /api/orders/:id/attribute — Link an order to a campaign (attribution)
router.post('/:id/attribute', validateObjectId(), requireFields(['campaignId']), ctrl.attributeOrder);

module.exports = router;
