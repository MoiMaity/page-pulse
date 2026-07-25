import { cacheKeyFor } from '../lib/url-guard.js';
import { analyze } from './analyzer.js';

/**
 * Orchestrates one audit:
 *
 *   cache lookup -> single-flight -> concurrency semaphore -> fetch -> analyze
 *
 * Everything expensive happens behind the semaphore, and identical concurrent
 * requests share a single fetch.
 *
 * @param {{ config: any, cache: any, semaphore: any, singleFlight: any, fetchPage: Function }} deps
 */
export function createAuditor({ config, cache, semaphore, singleFlight, fetchPage }) {
  /**
   * @param {URL} url
   * @param {{ maxAgeSeconds?: number, fresh?: boolean, log?: any }} [options]
   */
  return async function audit(url, { maxAgeSeconds, fresh = false, log } = {}) {
    const key = cacheKeyFor(url);
    const startedAt = performance.now();

    // Per-request window, clamped to the configured ceiling. Omitted means the
    // service default (CACHE_TTL_SECONDS).
    const windowSeconds = Math.min(
      maxAgeSeconds ?? config.cacheTtlSeconds,
      config.cacheMaxTtlSeconds,
    );

    if (!fresh && windowSeconds > 0) {
      const hit = cache.get(key);
      if (hit && hit.ageMs <= windowSeconds * 1000) {
        log?.info({ event: 'cache_hit', url: key, ageMs: hit.ageMs });
        return {
          result: hit.value,
          cache: {
            hit: true,
            ageSeconds: Math.round(hit.ageMs / 1000),
            windowSeconds,
            expiresAt: new Date(hit.storedAt + windowSeconds * 1000).toISOString(),
          },
          durationMs: Math.round(performance.now() - startedAt),
          coalesced: false,
        };
      }
    }

    log?.info({ event: 'cache_miss', url: key, fresh });

    const { value: result, coalesced } = await singleFlight.run(key, async () => {
      const release = await semaphore.acquire(); // rejects with 503 when the queue is full
      try {
        const page = await fetchPage(url, { log });
        const report = analyze(page);
        // Entries live for the configured ceiling; freshness is decided per
        // request, so a short default window and a long-lived entry coexist.
        cache.set(key, report, config.cacheMaxTtlSeconds * 1000);
        return report;
      } finally {
        release();
      }
    });

    return {
      result,
      cache: {
        hit: false,
        ageSeconds: 0,
        windowSeconds,
        expiresAt: new Date(Date.now() + windowSeconds * 1000).toISOString(),
      },
      durationMs: Math.round(performance.now() - startedAt),
      coalesced,
    };
  };
}
