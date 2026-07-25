import { randomUUID } from 'node:crypto';

const HEADER = 'x-request-id';
// Accept an upstream ID only if it is short and boring — it ends up in logs.
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Gives every request a stable ID: reused from the edge if one was supplied,
 * otherwise generated. It is echoed on the response and attached to every log
 * line and error body, so a user-reported failure can be traced in one grep.
 */
export function requestId() {
  return function requestIdMiddleware(req, res, next) {
    const incoming = req.get(HEADER);
    req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}
