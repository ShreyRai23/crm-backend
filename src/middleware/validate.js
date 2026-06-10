'use strict';

/**
 * Request Validation Helpers
 *
 * Lightweight validation utilities used by controllers.
 * Avoids a heavy validation library dependency while keeping
 * controller code clean.
 */

const { AppError } = require('./errorHandler');

/**
 * Validates that required fields are present in req.body.
 * @param {string[]} fields - Array of required field names.
 * @returns Express middleware
 */
const requireFields = (fields) => (req, _res, next) => {
  const missing = fields.filter(
    (f) => req.body[f] === undefined || req.body[f] === null || req.body[f] === ''
  );
  if (missing.length > 0) {
    return next(
      new AppError(
        `Missing required fields: ${missing.join(', ')}`,
        400,
        'MISSING_FIELDS'
      )
    );
  }
  next();
};

/**
 * Validates pagination query parameters.
 * Normalizes limit and cursor into req.pagination.
 */
const parsePagination = (req, _res, next) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const cursor = req.query.cursor || null;
  const cursorId = req.query.cursorId || null;
  const page = parseInt(req.query.page, 10) || 1;
  const skip = (page - 1) * limit;

  req.pagination = { limit, cursor, cursorId, page, skip };
  next();
};

/**
 * Validates that a value is a valid MongoDB ObjectId hex string.
 */
const isValidObjectId = (id) => /^[a-f\d]{24}$/i.test(id);

/**
 * Middleware to validate :id route param is a valid ObjectId.
 */
const validateObjectId = (paramName = 'id') => (req, _res, next) => {
  const id = req.params[paramName];
  if (!isValidObjectId(id)) {
    return next(
      new AppError(`'${id}' is not a valid resource ID`, 400, 'INVALID_ID')
    );
  }
  next();
};

module.exports = { requireFields, parsePagination, validateObjectId, isValidObjectId };
