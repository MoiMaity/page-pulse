import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { TtlCache } from './lib/cache.js';
import { Semaphore } from './lib/semaphore.js';
import { SingleFlight } from './lib/single-flight.js';
import { createUrlGuard } from './lib/url-guard.js';
import { createFetcher } from './services/fetcher.js';
import { createAuditor } from './services/auditor.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { auditRouter } from './routes/audit.js';
import { healthRouter } from './routes/health.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

/**
 * Builds a fully wired app. Every collaborator is injectable, which is what
 * makes the test suite fast and hermetic: tests pass a stub `fetchImpl` and a
 * stub DNS `lookup` and never touch the network.
 *
 * @param {{ config?: object, logger?: object, fetchImpl?: Function, lookup?: Function }} [overrides]
 */
export function createApp(overrides = {}) {
  const config = overrides.config ?? loadConfig();
  const logger = overrides.logger ?? createLogger(config);

  const cache = new TtlCache({
    maxEntries: config.cacheMaxEntries,
    defaultTtlMs: config.cacheMaxTtlSeconds * 1000,
  });
  const semaphore = new Semaphore({
    maxConcurrent: config.maxConcurrentAudits,
    maxQueue: config.maxQueuedAudits,
  });
  const singleFlight = new SingleFlight();

  const guard = createUrlGuard({ mode: config.ssrfProtection, lookup: overrides.lookup });
  const fetchPage = createFetcher({ config, fetchImpl: overrides.fetchImpl, guard });
  const audit = createAuditor({ config, cache, semaphore, singleFlight, fetchPage });

  const rateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
  });

  const app = express();
  const startedAt = Date.now();

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(compression());
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(requestId());
  app.use(requestLogger(logger));

  // Probes and the static page stay outside the limiter: an uptime check must
  // never be throttled, and the limiter protects outbound fetches, not disk.
  app.use(healthRouter({ config, cache, semaphore, singleFlight, rateLimiter, startedAt }));
  app.use(express.static(publicDir, { maxAge: config.isProduction ? '1h' : 0, index: 'index.html' }));

  app.use('/api', rateLimiter, auditRouter({ audit }));

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  // Exposed for tests and for graceful shutdown.
  app.locals.config = config;
  app.locals.logger = logger;
  app.locals.cache = cache;
  app.locals.semaphore = semaphore;
  app.locals.singleFlight = singleFlight;
  app.locals.rateLimiter = rateLimiter;
  app.locals.shutdown = () => rateLimiter.stop();

  return app;
}
