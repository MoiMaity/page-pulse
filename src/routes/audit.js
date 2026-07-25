import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { validationError } from '../lib/errors.js';
import { normalizeUrl } from '../lib/url-guard.js';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

/**
 * `.strict()` means a typo like `{ "urls": "..." }` is rejected with a clear
 * message instead of silently auditing nothing.
 */
const auditInput = z
  .object({
    url: z.string({ required_error: 'url is required' }).trim().min(1, 'url must not be empty').max(2048),
    maxAge: z.coerce
      .number()
      .int('maxAge must be a whole number of seconds')
      .min(0)
      .max(86400)
      .optional(),
    fresh: booleanish.optional(),
  })
  .strict();

/**
 * @param {{ audit: Function }} deps
 */
export function auditRouter({ audit }) {
  const router = Router();

  const handle = asyncHandler(async (req, res) => {
    const raw = req.method === 'GET' ? req.query : req.body;
    const parsed = auditInput.safeParse(raw ?? {});

    if (!parsed.success) {
      throw validationError(
        'The request parameters are invalid.',
        parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(body)',
          message: issue.message,
        })),
      );
    }

    const { url: rawUrl, maxAge, fresh } = parsed.data;
    const url = normalizeUrl(rawUrl); // throws INVALID_URL / UNSUPPORTED_PROTOCOL / URL_NOT_ALLOWED

    const { result, cache, durationMs, coalesced } = await audit(url, {
      maxAgeSeconds: maxAge,
      fresh: fresh ?? false,
      log: req.log,
    });

    res.setHeader('X-Cache', cache.hit ? 'HIT' : 'MISS');
    res.setHeader('Cache-Control', 'no-store');

    res.status(200).json({
      requestId: req.id,
      durationMs,
      cache,
      ...(coalesced ? { coalesced: true } : {}),
      result,
    });
  });

  router.get('/audit', handle);
  router.post('/audit', handle);

  return router;
}
