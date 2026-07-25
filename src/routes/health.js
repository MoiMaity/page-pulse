import { Router } from 'express';

/**
 * `/healthz` is the liveness probe: cheap, dependency-free, never rate limited.
 * `/api/stats` exposes the internals an operator actually wants during an
 * incident — cache hit ratio, queue depth, in-flight audits.
 *
 * @param {{ config: any, cache: any, semaphore: any, singleFlight: any, rateLimiter: any, startedAt: number }} deps
 */
export function healthRouter({ config, cache, semaphore, singleFlight, rateLimiter, startedAt }) {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      version: process.env.npm_package_version || '1.0.0',
      env: config.env,
    });
  });

  router.get('/api/stats', (_req, res) => {
    res.status(200).json({
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      cache: { ...cache.stats(), defaultWindowSeconds: config.cacheTtlSeconds, maxWindowSeconds: config.cacheMaxTtlSeconds },
      concurrency: semaphore.stats(),
      singleFlight: singleFlight.stats(),
      rateLimit: rateLimiter.stats(),
      memory: {
        rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
        heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
      },
    });
  });

  return router;
}
