import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config);

const app = createApp({ config, logger });

const server = app.listen(config.port, config.host, () => {
  logger.info(
    {
      event: 'server_started',
      port: config.port,
      host: config.host,
      cacheWindowSeconds: config.cacheTtlSeconds,
      rateLimit: `${config.rateLimitMax}/${config.rateLimitWindowMs / 1000}s`,
      maxConcurrentAudits: config.maxConcurrentAudits,
      ssrfProtection: config.ssrfProtection,
    },
    'Page Pulse is listening',
  );
});

// Requests already in flight get a chance to finish; new ones are refused.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: 'shutdown_started', signal }, 'shutting down');

  app.locals.shutdown?.();

  server.close((err) => {
    if (err) {
      logger.error({ event: 'shutdown_failed', err }, 'shutdown failed');
      process.exit(1);
    }
    logger.info({ event: 'shutdown_complete' }, 'shutdown complete');
    process.exit(0);
  });

  // Do not hang forever on a stuck keep-alive connection.
  setTimeout(() => {
    logger.error({ event: 'shutdown_forced' }, 'forcing shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ event: 'unhandled_rejection', err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ event: 'uncaught_exception', err }, 'uncaught exception, exiting');
  shutdown('uncaughtException');
});
