'use strict';

const router = require('express').Router();
const { register, login, getMe, updateMe } = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');

// Public routes
router.post('/register', register);
router.post('/login',    login);

// Protected — requires valid JWT
router.get('/me',    protect, getMe);
router.patch('/me',  protect, updateMe);

module.exports = router;
