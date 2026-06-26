'use strict';

/**
 * Auth Middleware
 *
 * protect() — verifies JWT from the Authorization header.
 * Attaches the decoded user payload to req.user.
 * All protected API routes use this middleware.
 */

const jwt  = require('jsonwebtoken');
const User = require('../models/User');
const { AppError } = require('./errorHandler');

const JWT_SECRET = process.env.JWT_SECRET || 'kinetics_crm_dev_secret_change_in_prod';

/**
 * Extracts and verifies the Bearer token from the Authorization header.
 * Attaches req.user = { _id, name, email, role } on success.
 */
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Authentication required. Please log in.', 401, 'UNAUTHORIZED'));
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(new AppError('Your session has expired. Please log in again.', 401, 'TOKEN_EXPIRED'));
      }
      return next(new AppError('Invalid authentication token.', 401, 'INVALID_TOKEN'));
    }

    // Verify user still exists in DB (handles deleted accounts)
    const user = await User.findById(decoded.id).select('_id name email role');
    if (!user) {
      return next(new AppError('User account no longer exists.', 401, 'USER_NOT_FOUND'));
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { protect };
