import pino from 'pino';

/**
 * JSON logs to stdout — the format every hosted platform (Render, Fly, Cloud
 * Run, ECS) already knows how to index. No file handling, no rotation, no
 * transport in production: the platform owns that.
 *
 * @param {{ logLevel: string, env: string, isTest: boolean }} config
 */
export function createLogger(config) {
  return pino({
    level: config.isTest ? 'silent' : config.logLevel,
    base: { service: 'page-pulse', env: config.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', '*.apiKey'],
      remove: true,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
