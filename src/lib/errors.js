/**
 * A single error type carries everything the HTTP layer needs: status, a
 * stable machine-readable code, a human message and optional details. The
 * error handler is then the only place that knows how to serialise it.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code stable SCREAMING_SNAKE identifier, safe to switch on
   * @param {string} message
   * @param {{ details?: unknown, retryAfterSeconds?: number, cause?: unknown }} [options]
   */
  constructor(status, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.expose = status < 500;
  }
}

export const validationError = (message, details) =>
  new HttpError(400, 'VALIDATION_ERROR', message, { details });

export const invalidUrl = (message = 'The supplied value is not a valid absolute URL.') =>
  new HttpError(400, 'INVALID_URL', message);

export const unsupportedProtocol = (protocol) =>
  new HttpError(400, 'UNSUPPORTED_PROTOCOL', `Only http and https URLs can be audited (received "${protocol}").`);

export const urlNotAllowed = (message, details) =>
  new HttpError(403, 'URL_NOT_ALLOWED', message, { details });

export const dnsResolutionFailed = (hostname, cause) =>
  new HttpError(400, 'DNS_RESOLUTION_FAILED', `The hostname "${hostname}" could not be resolved.`, { cause });

export const notFound = (path) =>
  new HttpError(404, 'NOT_FOUND', `No route matches ${path}.`);

export const rateLimited = (retryAfterSeconds) =>
  new HttpError(429, 'RATE_LIMITED', 'Rate limit exceeded for this client. Retry after the window resets.', {
    retryAfterSeconds,
  });

export const serverBusy = (retryAfterSeconds = 5) =>
  new HttpError(503, 'SERVER_BUSY', 'The audit queue is full. Retry shortly.', { retryAfterSeconds });

export const upstreamTimeout = (timeoutMs) =>
  new HttpError(504, 'UPSTREAM_TIMEOUT', `The target site did not respond within ${timeoutMs}ms.`);

export const upstreamUnreachable = (message, cause) =>
  new HttpError(502, 'UPSTREAM_UNREACHABLE', message, { cause });

export const upstreamTooLarge = (maxBytes) =>
  new HttpError(502, 'UPSTREAM_TOO_LARGE', `The target page exceeds the ${maxBytes} byte limit.`);

export const tooManyRedirects = (max) =>
  new HttpError(502, 'TOO_MANY_REDIRECTS', `The target site redirected more than ${max} times.`);

export const unsupportedContentType = (contentType) =>
  new HttpError(415, 'UNSUPPORTED_CONTENT_TYPE', `Only HTML documents can be audited (received "${contentType || 'unknown'}").`);

export const internalError = (cause) =>
  new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed.', { cause });
