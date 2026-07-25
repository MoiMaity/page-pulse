import { HttpError, notFound } from '../lib/errors.js';

/** Anything that falls through the router is a 404 in the same error shape. */
export function notFoundHandler() {
  return function notFoundMiddleware(req, _res, next) {
    next(notFound(req.originalUrl));
  };
}

/**
 * The single place that turns an error into a response body. Every failure —
 * validation, rate limit, upstream timeout, unexpected crash — leaves through
 * here, so clients only ever have to parse one shape.
 *
 * @param {import('pino').Logger} logger
 */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
  return function errorMiddleware(err, req, res, next) {
    const normalised = normalise(err);
    const log = req.log || logger;

    if (normalised.status >= 500) {
      log.error({ event: 'request_failed', code: normalised.code, err }, normalised.message);
    } else {
      log.warn({ event: 'request_rejected', code: normalised.code, status: normalised.status }, normalised.message);
    }

    if (res.headersSent) return;

    if (normalised.retryAfterSeconds) {
      res.setHeader('Retry-After', String(normalised.retryAfterSeconds));
    }

    res.status(normalised.status).json({
      error: {
        code: normalised.code,
        message: normalised.message,
        ...(normalised.details ? { details: normalised.details } : {}),
        requestId: req.id || null,
        timestamp: new Date().toISOString(),
      },
    });
  };
}

function normalise(err) {
  if (err instanceof HttpError) return err;

  // body-parser failures arrive as plain errors with a `type` discriminator.
  if (err?.type === 'entity.parse.failed') {
    return new HttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
  if (err?.type === 'entity.too.large') {
    return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is larger than the accepted limit.');
  }

  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed.', { cause: err });
}
