/**
 * One structured line per completed request, plus a child logger on `req.log`
 * so anything deeper in the stack inherits the request ID automatically.
 *
 * @param {import('pino').Logger} logger
 */
export function requestLogger(logger) {
  return function requestLoggerMiddleware(req, res, next) {
    const startedAt = process.hrtime.bigint();
    req.log = logger.child({ requestId: req.id });

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      req.log[level](
        {
          event: 'request_completed',
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          ip: req.ip,
          userAgent: req.get('user-agent') || null,
          cache: res.getHeader('X-Cache') || null,
        },
        'request completed',
      );
    });

    next();
  };
}
