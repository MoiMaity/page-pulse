import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * Builds an app with the network fully stubbed out.
 *
 * Both outbound dependencies are injected — DNS resolution and fetch — so the
 * suite is deterministic, runs offline, and still exercises the real SSRF
 * guard rather than switching it off.
 */
export function buildApp({ env = {}, fetchImpl, lookup = publicLookup } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env });
  return createApp({ config, fetchImpl, lookup });
}

/** Every hostname resolves to a public address unless a test says otherwise. */
export const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

export const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];

/**
 * @param {Record<string, object|Function>|Function} handlers keyed by absolute
 *   URL, with '*' as a catch-all. A handler may be a spec object or a function.
 */
export function stubFetch(handlers) {
  const calls = [];

  const impl = async (url, options = {}) => {
    calls.push({ url, options });

    const handler =
      typeof handlers === 'function' ? handlers : handlers[url] ?? handlers[stripTrailingSlash(url)] ?? handlers['*'];

    if (!handler) throw new Error(`No fetch stub registered for ${url}`);

    const spec = typeof handler === 'function' ? await handler(url, options) : handler;

    return new Response(spec.body ?? null, {
      status: spec.status ?? 200,
      headers: spec.headers ?? { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  impl.calls = calls;
  impl.count = () => calls.length;
  return impl;
}

/** A fetch that never resolves until the request is aborted. */
export const hangingFetch = (_url, { signal } = {}) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

/** A fetch whose resolution the test controls. */
export function deferredFetch(html = GOOD_PAGE) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const impl = async () => {
    impl.started += 1;
    await gate;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };

  impl.started = 0;
  impl.release = () => release();
  return impl;
}

export const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-encoding': 'gzip',
  'cache-control': 'public, max-age=600',
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export const GOOD_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kettle Bridge Coffee — small-batch roasting in Leeds</title>
    <meta name="description" content="A small-batch coffee roastery in Leeds. We roast to order every Tuesday and ship anywhere in the UK within two days." />
    <link rel="canonical" href="https://example.com/" />
    <meta property="og:title" content="Kettle Bridge Coffee" />
    <meta property="og:description" content="Small-batch coffee roasted to order in Leeds." />
    <script src="/app.js" defer></script>
  </head>
  <body>
    <h1>Small-batch coffee, roasted to order</h1>
    <p>${'We roast every Tuesday morning and ship the same afternoon. '.repeat(20)}</p>
    <h2>How subscriptions work</h2>
    <img src="/bags.jpg" alt="Paper bags of coffee cooling on a rack" />
    <a href="/subscriptions">Read about subscriptions</a>
    <a href="https://roastersguild.example.org">Roasters Guild</a>
  </body>
</html>`;

export const POOR_PAGE = `<!doctype html>
<html>
  <head>
    <script src="/vendor.js"></script>
  </head>
  <body>
    <img src="http://cdn.example.net/hero.jpg" />
    <a href="/more">click here</a>
    <a href="/empty"></a>
  </body>
</html>`;

function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
