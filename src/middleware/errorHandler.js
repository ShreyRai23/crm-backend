'use strict';

/**
 * Centralized Error Handling Middleware
 *
 * All errors passed via next(err) are handled here.
 * Returns a consistent JSON error envelope:
 * { success: false, error: { code, message, details? } }
 */

// ─── Custom AppError class ────────────────────────────────────────────────────
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ─── Error Classifier ────────────────────────────────────────────────────────
const classifyError = (err) => {
  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details,
    };
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    return {
      statusCode: 400,
      code: 'INVALID_ID',
      message: `Invalid value for field '${err.path}': ${err.value}`,
    };
  }

  // MongoDB duplicate key (E11000)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    const value = err.keyValue ? err.keyValue[field] : '';
    return {
      statusCode: 409,
      code: 'DUPLICATE_KEY',
      message: `Duplicate value for ${field}: '${value}'. A record with this value already exists.`,
    };
  }

  // JWT / Auth errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return {
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired authentication token',
    };
  }

  // Our own operational errors
  if (err.isOperational) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
    };
  }

  // Unknown / programming errors — don't leak details in production
  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message:
      process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message,
  };
};

// ─── Middleware ───────────────────────────────────────────────────────────────
const errorHandler = (err, req, res, _next) => {
  const classified = classifyError(err);

  // Always log the full error server-side
  console.error(`[Error] ${req.method} ${req.path}`, {
    code: classified.code,
    message: classified.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });

  const body = {
    success: false,
    error: {
      code: classified.code,
      message: classified.message,
    },
  };

  if (classified.details) {
    body.error.details = classified.details;
  }

  return res.status(classified.statusCode).json(body);
};

// ─── 404 Not Found handler ────────────────────────────────────────────────────
const notFound = (req, res, _next) => {
  return res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
};

module.exports = { errorHandler, notFound, AppError };
