'use strict';

/**
 * Auth Controller
 *
 * Handles user registration, login, and session validation.
 *
 * POST /api/auth/register  — create account, return JWT
 * POST /api/auth/login     — validate credentials, return JWT
 * GET  /api/auth/me        — return current user from token
 */

const jwt  = require('jsonwebtoken');
const User = require('../models/User');
const { AppError } = require('../middleware/errorHandler');

const JWT_SECRET  = process.env.JWT_SECRET  || 'kinetics_crm_dev_secret_change_in_prod';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

// ─── Helper: sign a JWT for a given user ID ───────────────────────────────────
const signToken = (userId) =>
  jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

// ─── Helper: send token response ─────────────────────────────────────────────
const sendTokenResponse = (res, statusCode, user, token) => {
  // Never send password back
  const userOut = {
    _id:   user._id,
    name:  user.name,
    email: user.email,
    role:  user.role,
  };
  return res.status(statusCode).json({
    success: true,
    token,
    user: userOut,
  });
};

// ─── POST /api/auth/register ──────────────────────────────────────────────────
const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return next(new AppError('Name, email, and password are required.', 400, 'MISSING_FIELDS'));
    }
    if (password.length < 6) {
      return next(new AppError('Password must be at least 6 characters.', 400, 'WEAK_PASSWORD'));
    }

    // Check for existing account (provides a clearer error than the DB unique index)
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return next(new AppError('An account with this email already exists.', 409, 'EMAIL_TAKEN'));
    }

    const user = await User.create({ name, email, password });
    const token = signToken(user._id);

    console.log(`[Auth] New user registered: ${user.email}`);
    return sendTokenResponse(res, 201, user, token);
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return next(new AppError('Email and password are required.', 400, 'MISSING_FIELDS'));
    }

    // Explicitly select password — it's excluded by default via schema `select: false`
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!user) {
      // Generic message — don't reveal whether email exists
      return next(new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS'));
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return next(new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS'));
    }

    const token = signToken(user._id);
    console.log(`[Auth] User logged in: ${user.email}`);
    return sendTokenResponse(res, 200, user, token);
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
// Protected by auth middleware — req.user is already populated
const getMe = async (req, res) => {
  return res.json({
    success: true,
    user: {
      _id:   req.user._id,
      name:  req.user.name,
      email: req.user.email,
      role:  req.user.role,
    },
  });
};

// ─── PATCH /api/auth/me ───────────────────────────────────────────────────────
// Allows the logged-in user to update their own name and/or password.
const updateMe = async (req, res, next) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    const userId = req.user._id;

    const user = await User.findById(userId).select('+password');
    if (!user) return next(new AppError('User not found.', 404, 'NOT_FOUND'));

    // Update name if provided
    if (name && name.trim()) {
      user.name = name.trim();
    }

    // Update password if both fields provided
    if (newPassword) {
      if (!currentPassword) {
        return next(new AppError('Current password is required to set a new password.', 400, 'MISSING_FIELDS'));
      }
      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        return next(new AppError('Current password is incorrect.', 401, 'INVALID_CREDENTIALS'));
      }
      if (newPassword.length < 6) {
        return next(new AppError('New password must be at least 6 characters.', 400, 'WEAK_PASSWORD'));
      }
      user.password = newPassword; // Pre-save hook will hash it
    }

    await user.save();

    console.log(`[Auth] Profile updated: ${user.email}`);
    return res.json({
      success: true,
      user: {
        _id:   user._id,
        name:  user.name,
        email: user.email,
        role:  user.role,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, getMe, updateMe };

