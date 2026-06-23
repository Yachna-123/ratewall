'use strict';

const { SlidingWindowCounter } = require('./sliding-window-counter');
const { MemoryStore } = require('./memory-store');

/**
 * Default key generator: rate-limit per client IP address.
 * Honors X-Forwarded-For when Express's trust proxy setting has been
 * configured correctly (req.ip already accounts for that), so this
 * does NOT read X-Forwarded-For directly itself — doing so manually
 * would let a client spoof their own rate-limit identity by setting
 * the header themselves on a server that isn't actually behind a proxy.
 */
function ipKeyGenerator(req) {
  return req.ip;
}

/**
 * Creates an Express middleware function backed by a SlidingWindowCounter.
 *
 * @param {object} opts
 * @param {number} opts.windowMs - size of the rate-limit window in ms
 * @param {number} opts.max - max requests allowed per window per key
 * @param {object} [opts.store] - a store implementing checkAndIncrement;
 *        defaults to a single-process MemoryStore if omitted. For
 *        multi-instance deployments, pass a RedisStore instead — the
 *        in-memory default only protects one process and will under-count
 *        if you run more than one instance behind a load balancer.
 * @param {(req: import('express').Request) => string} [opts.keyGenerator] -
 *        function deriving the rate-limit key from a request. Defaults
 *        to per-IP. Pass a custom function for per-user or per-API-key
 *        limiting, e.g. (req) => req.user?.id ?? req.ip
 * @param {boolean} [opts.standardHeaders] - if true (default), sets
 *        RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset headers
 *        on every response, per the IETF draft conventions.
 * @param {(req, res) => void} [opts.handler] - custom handler invoked when
 *        a request is blocked, instead of the default 429 JSON response.
 * @returns {import('express').RequestHandler}
 */
function ratewall(opts = {}) {
  const {
    windowMs,
    max,
    store = new MemoryStore(),
    keyGenerator = ipKeyGenerator,
    standardHeaders = true,
    handler,
  } = opts;

  const limiter = new SlidingWindowCounter({ windowMs, max, store });

  return async function ratewallMiddleware(req, res, next) {
    let key;
    try {
      key = keyGenerator(req);
    } catch (err) {
      // a broken keyGenerator should not take the whole app down —
      // fail open and let the request through, but surface the error.
      return next(err);
    }

    let result;
    try {
      result = await limiter.check(key);
    } catch (err) {
      // Store errors (e.g. Redis connection drop) should not be treated
      // the same as "rate limit exceeded" — that would turn an infra
      // outage into an outage for every one of your users at once.
      // Fail OPEN: let the request through, but pass the error along so
      // the app can log/alert on it.
      return next(err);
    }

    if (standardHeaders) {
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.floor(result.remaining)));
      res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
    }

    if (!result.allowed) {
      if (typeof handler === 'function') {
        return handler(req, res);
      }
      res.setHeader('Retry-After', String(Math.ceil(result.resetMs / 1000)));
      return res.status(429).json({
        error: 'Too Many Requests',
        retryAfterMs: result.resetMs,
      });
    }

    return next();
  };
}

module.exports = { ratewall, ipKeyGenerator };
