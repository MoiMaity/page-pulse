import { z } from 'zod';

/**
 * Every tunable knob in the service lives here. Nothing reads process.env
 * directly, so tests can build an app with any configuration they like and
 * a bad deploy fails at boot instead of at the first request.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Number of reverse proxies in front of the app (Render/Fly/Heroku = 1).
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),

  // --- Caching -------------------------------------------------------------
  // Default freshness window: a repeat audit inside this window is served
  // from cache without refetching the target page.
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  // Hard ceiling for a per-request `maxAge` override, and the lifetime of a
  // stored entry.
  CACHE_MAX_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(3600),
  CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(100000).default(500),

  // --- Rate limiting -------------------------------------------------------
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(100000).default(20),

  // --- Concurrency ---------------------------------------------------------
  // Outbound fetches happen behind a semaphore so one burst of traffic cannot
  // exhaust sockets or memory.
  MAX_CONCURRENT_AUDITS: z.coerce.number().int().min(1).max(1000).default(8),
  MAX_QUEUED_AUDITS: z.coerce.number().int().min(0).max(10000).default(32),

  // --- Outbound fetch ------------------------------------------------------
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
  FETCH_MAX_BYTES: z.coerce.number().int().min(1024).default(2_000_000),
  FETCH_MAX_REDIRECTS: z.coerce.number().int().min(0).max(20).default(5),
  USER_AGENT: z
    .string()
    .min(1)
    .default('PagePulseBot/1.0 (+https://github.com/your-username/page-pulse)'),

  // 'strict' refuses URLs that resolve to private, loopback or link-local
  // addresses (SSRF protection). Only turn it off for local testing.
  SSRF_PROTECTION: z.enum(['strict', 'off']).default('strict'),

  // Max accepted JSON body size.
  BODY_LIMIT: z.string().min(2).default('8kb'),
});

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Readonly<object>} camelCased, validated configuration
 */
export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const e = parsed.data;

  return Object.freeze({
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,

    cacheTtlSeconds: e.CACHE_TTL_SECONDS,
    cacheMaxTtlSeconds: Math.max(e.CACHE_MAX_TTL_SECONDS, e.CACHE_TTL_SECONDS),
    cacheMaxEntries: e.CACHE_MAX_ENTRIES,

    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_SECONDS * 1000,
    rateLimitMax: e.RATE_LIMIT_MAX_REQUESTS,

    maxConcurrentAudits: e.MAX_CONCURRENT_AUDITS,
    maxQueuedAudits: e.MAX_QUEUED_AUDITS,

    fetchTimeoutMs: e.FETCH_TIMEOUT_MS,
    fetchMaxBytes: e.FETCH_MAX_BYTES,
    fetchMaxRedirects: e.FETCH_MAX_REDIRECTS,
    userAgent: e.USER_AGENT,

    ssrfProtection: e.SSRF_PROTECTION,
    bodyLimit: e.BODY_LIMIT,
  });
}
