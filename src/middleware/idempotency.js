'use strict';

/**
 * Idempotency Middleware
 *
 * Prevents duplicate side effects when clients retry requests.
 * Clients must send an `Idempotency-Key` header (UUID recommended).
 *
 * Flow:
 *   1. Extract Idempotency-Key from request header.
 *   2. If key found in cache → return the cached response immediately.
 *   3. If key is new → intercept res.json() to cache the response,
 *      then proceed normally.
 *
 * Cache: In-memory Map (suitable for single-instance; swap for Redis in prod).
 * TTL: 24 hours (keys expire after one day).
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory store: Map<key, { statusCode, body, expiresAt }>
const idempotencyCache = new Map();

// ─── Cleanup expired entries every hour ──────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache.entries()) {
    if (entry.expiresAt < now) {
      idempotencyCache.delete(key);
    }
  }
}, 60 * 60 * 1000);

/**
 * idempotency middleware factory.
 * Use on routes where duplicate submission must be prevented.
 *
 * @example
 *   router.post('/campaigns', idempotency(), campaignController.create);
 */
const idempotency = () => {
  return (req, res, next) => {
    const key = req.headers['idempotency-key'];

    // No key provided — skip idempotency (make it optional)
    if (!key) {
      return next();
    }

    const cached = idempotencyCache.get(key);

    if (cached) {
      // Key already processed — return cached response
      if (cached.expiresAt < Date.now()) {
        idempotencyCache.delete(key);
        return next();
      }
      console.log(`[Idempotency] Cache hit for key: ${key}`);
      return res.status(cached.statusCode).json({
        ...cached.body,
        _idempotent: true, // Signals to client this is a replayed response
      });
    }

    // Intercept res.json to capture the response for caching
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      // Only cache successful responses (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        idempotencyCache.set(key, {
          statusCode: res.statusCode,
          body,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        console.log(`[Idempotency] Cached response for key: ${key}`);
      }
      return originalJson(body);
    };

    next();
  };
};

module.exports = { idempotency };
