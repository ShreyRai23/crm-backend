'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/receipt.controller');

// POST /api/receipt/delivery — Webhook from Channel Service
// No auth middleware — in production this would use a shared HMAC secret
router.post('/delivery', ctrl.handleDeliveryReceipt);

module.exports = router;
