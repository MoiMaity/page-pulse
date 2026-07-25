import { rateLimited } from '../lib/errors.js';

/**
 * Fixed-window rate limiter, keyed per client.
 *
 * Fixed window is chosen over a token bucket for one reason: the reset time is
 * exact, so `RateLimit-Reset` and `Retry-After` are honest numbers a client can
 * act on. State is per-process; behind multiple instances each replica enforces
 * its own share (documented in the README).
 *
 * @param {{ windowMs: number, max: number, keyGenerator?: (req) => string, skip?: (req) => boolean }} options
 */
export function createRateLimiter({ windowMs, max, keyGenerator = defaultKey, skip = () => false }) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  sweeper.unref?.(); // never hold the process open

  function middleware(req, res, next) {
    if (skip(req)) return next();

    const now = Date.now();
    const key = keyGenerator(req);
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      req.log?.warn({ event: 'rate_limit_exceeded', key, count: bucket.count, limit: max });
      return next(rateLimited(resetSeconds));
    }

    return next();
  }

  middleware.reset = () => buckets.clear();
  middleware.stop = () => clearInterval(sweeper);
  middleware.stats = () => ({ trackedClients: buckets.size, windowMs, max });

  return middleware;
}

/** API key if one is presented, otherwise the client IP (proxy-aware). */
function defaultKey(req) {
  const apiKey = req.get('x-api-key');
  return apiKey ? `key:${apiKey}` : `ip:${req.ip || 'unknown'}`;
}
