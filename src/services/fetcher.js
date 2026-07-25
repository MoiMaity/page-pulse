import {
  HttpError,
  upstreamTimeout,
  upstreamUnreachable,
  upstreamTooLarge,
  tooManyRedirects,
  unsupportedContentType,
} from '../lib/errors.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * @param {{ config: any, fetchImpl?: typeof fetch, guard: (url: URL) => Promise<void> }} deps
 */
export function createFetcher({ config, fetchImpl = globalThis.fetch, guard }) {
  /**
   * Fetches a page under a hard deadline and a hard byte cap.
   *
   * Redirects are followed manually rather than by the fetch implementation so
   * that the SSRF guard runs on every hop, and so the redirect chain becomes
   * part of the audit output.
   *
   * @param {URL} initialUrl
   * @param {{ log?: any }} [options]
   */
  return async function fetchPage(initialUrl, { log } = {}) {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.fetchTimeoutMs);

    const startedAt = performance.now();
    /** @type {Array<{ from: string, to: string, status: number }>} */
    const redirects = [];

    try {
      let current = initialUrl;

      for (let hop = 0; hop <= config.fetchMaxRedirects; hop += 1) {
        await guard(current);

        let response;
        try {
          response = await fetchImpl(current.toString(), {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'user-agent': config.userAgent,
              accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
              'accept-language': 'en',
            },
          });
        } catch (cause) {
          if (timedOut || cause?.name === 'AbortError' || cause?.name === 'TimeoutError') {
            throw upstreamTimeout(config.fetchTimeoutMs);
          }
          throw upstreamUnreachable(
            `The target site could not be reached (${cause?.cause?.code || cause?.code || cause?.message || 'network error'}).`,
            cause,
          );
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          await cancelBody(response);

          if (!location) {
            throw new HttpError(
              502,
              'UPSTREAM_INVALID_REDIRECT',
              `The target returned ${response.status} without a Location header.`,
            );
          }

          let next;
          try {
            next = new URL(location, current);
          } catch {
            throw new HttpError(502, 'UPSTREAM_INVALID_REDIRECT', `The redirect target "${location}" is not a valid URL.`);
          }

          redirects.push({ from: current.toString(), to: next.toString(), status: response.status });
          log?.debug({ event: 'redirect_followed', from: current.toString(), to: next.toString() });
          current = next;
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        const isHtml = HTML_TYPES.some((type) => contentType.toLowerCase().includes(type));

        // A 4xx/5xx is a legitimate audit finding, so keep going and report it.
        // A 2xx that is not HTML is a user error worth rejecting loudly.
        if (response.ok && !isHtml) {
          await cancelBody(response);
          throw unsupportedContentType(contentType);
        }

        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > config.fetchMaxBytes) {
          await cancelBody(response);
          throw upstreamTooLarge(config.fetchMaxBytes);
        }

        const { bytes, buffer, truncated } = isHtml
          ? await readCapped(response, config.fetchMaxBytes)
          : { bytes: 0, buffer: new Uint8Array(0), truncated: false };

        if (!isHtml) await cancelBody(response);

        const totalMs = Math.round(performance.now() - startedAt);

        return {
          requestedUrl: initialUrl.toString(),
          finalUrl: current.toString(),
          status: response.status,
          headers: headersToObject(response.headers),
          html: isHtml ? decode(buffer, contentType) : '',
          bytes,
          truncated,
          redirects,
          timings: { totalMs },
        };
      }

      throw tooManyRedirects(config.fetchMaxRedirects);
    } catch (error) {
      if (timedOut && !(error instanceof HttpError)) throw upstreamTimeout(config.fetchTimeoutMs);
      if (error instanceof HttpError) throw error;
      throw upstreamUnreachable(`The target site could not be audited (${error?.message || 'unknown error'}).`, error);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Reads the body, stopping once the cap is reached rather than buffering it all. */
async function readCapped(response, maxBytes) {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { buffer: buffer.slice(0, maxBytes), bytes: buffer.byteLength, truncated: buffer.byteLength > maxBytes };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    received += value.byteLength;
    if (received > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (received - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => {});
      received = maxBytes;
      break;
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { buffer, bytes: received, truncated };
}

function decode(buffer, contentType) {
  const match = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const label = match?.[1] || 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

function headersToObject(headers) {
  const out = {};
  for (const [key, value] of headers) out[key.toLowerCase()] = value;
  return out;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    /* the connection is going away anyway */
  }
}
