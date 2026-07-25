/**
 * Express 4 does not forward rejected promises to the error handler, so async
 * route handlers are wrapped rather than each one carrying its own try/catch.
 * @param {Function} fn
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
