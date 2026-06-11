'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/customer.controller');
const { parsePagination, validateObjectId, requireFields } = require('../middleware/validate');

// GET /api/customers/stats — must be BEFORE /:id to avoid 'stats' being cast as ObjectId
router.get('/stats', ctrl.getCustomerStats);

// GET /api/customers
router.get('/', parsePagination, ctrl.listCustomers);

// GET /api/customers/:id
router.get('/:id', validateObjectId(), ctrl.getCustomer);

// GET /api/customers/:id/campaign-history — customer's communication history
router.get('/:id/campaign-history', validateObjectId(), ctrl.getCampaignHistory);

// POST /api/customers
router.post('/', requireFields(['name', 'email']), ctrl.createCustomer);

// PUT /api/customers/:id
router.put('/:id', validateObjectId(), ctrl.updateCustomer);

// DELETE /api/customers/:id
router.delete('/:id', validateObjectId(), ctrl.deleteCustomer);

// ── Consent Management (Opt-Out / Opt-In) ────────────────────────────────────
// POST /api/customers/:id/opt-out — unsubscribe from one or more channels
router.post(
  '/:id/opt-out',
  validateObjectId(),
  requireFields(['channels']),
  ctrl.optOut
);

// POST /api/customers/:id/opt-in — re-subscribe to one or more channels
router.post(
  '/:id/opt-in',
  validateObjectId(),
  requireFields(['channels']),
  ctrl.optIn
);

module.exports = router;
