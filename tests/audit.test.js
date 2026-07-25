import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import {
  buildApp,
  stubFetch,
  hangingFetch,
  privateLookup,
  GOOD_PAGE,
  POOR_PAGE,
  HTML_HEADERS,
} from './helpers.js';

let app;

afterEach(() => app?.locals.shutdown?.());

describe('a successful audit', () => {
  it('returns the full report envelope', async () => {
    app = buildApp({ fetchImpl: stubFetch({ '*': { body: GOOD_PAGE, headers: HTML_HEADERS } }) });

    const response = await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);

    expect(response.headers['x-cache']).toBe('MISS');
    expect(response.body).toMatchObject({
      requestId: expect.any(String),
      durationMs: expect.any(Number),
      cache: { hit: false, windowSeconds: expect.any(Number) },
    });

    const { result } = response.body;
    expect(result.finalUrl).toBe('https://example.com/');
    expect(result.http.status).toBe(200);
    expect(result.scores.overall).toBeGreaterThanOrEqual(0);
    expect(result.scores.overall).toBeLessThanOrEqual(100);
    expect(result.scores.grade).toMatch(/^[A-F]$/);
    expect(result.checks.length).toBeGreaterThan(15);
  });

  it('scores a well-built page above a neglected one', async () => {
    app = buildApp({ fetchImpl: stubFetch({ '*': { body: GOOD_PAGE, headers: HTML_HEADERS } }) });
    const good = await request(app).get('/api/audit').query({ url: 'https://good.example' }).expect(200);
    app.locals.shutdown();

    app = buildApp({ fetchImpl: stubFetch({ '*': { body: POOR_PAGE } }) });
    const poor = await request(app).get('/api/audit').query({ url: 'https://poor.example' }).expect(200);

    expect(good.body.result.scores.overall).toBeGreaterThan(poor.body.result.scores.overall + 25);
    expect(findCheck(poor.body.result, 'title_present').status).toBe('fail');
    expect(findCheck(poor.body.result, 'images_have_alt').status).toBe('fail');
    expect(findCheck(poor.body.result, 'no_mixed_content').status).toBe('fail');
    expect(findCheck(good.body.result, 'title_present').status).toBe('pass');
  });

  it('sends the configured user agent', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl, env: { USER_AGENT: 'PagePulseBot/test' } });

    await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);

    expect(fetchImpl.calls[0].options.headers['user-agent']).toBe('PagePulseBot/test');
  });
});

describe('upstream conditions', () => {
  it('audits a page that answers 404 rather than failing the request', async () => {
    app = buildApp({ fetchImpl: stubFetch({ '*': { status: 404, body: '<html><body>Gone</body></html>' } }) });

    const response = await request(app).get('/api/audit').query({ url: 'https://example.com/missing' }).expect(200);

    expect(response.body.result.http.status).toBe(404);
    expect(findCheck(response.body.result, 'http_status_ok').status).toBe('fail');
  });

  it('refuses to audit a non-HTML resource', async () => {
    app = buildApp({
      fetchImpl: stubFetch({ '*': { body: '%PDF-1.7', headers: { 'content-type': 'application/pdf' } } }),
    });

    const response = await request(app).get('/api/audit').query({ url: 'https://example.com/doc.pdf' }).expect(415);

    expect(response.body.error.code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('times out slow targets with a 504', async () => {
    app = buildApp({ fetchImpl: hangingFetch, env: { FETCH_TIMEOUT_MS: '150' } });

    const response = await request(app).get('/api/audit').query({ url: 'https://slow.example' }).expect(504);

    expect(response.body.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(response.body.error.message).toContain('150ms');
  });

  it('reports an unreachable host as a 502', async () => {
    app = buildApp({
      fetchImpl: async () => {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNREFUSED' };
        throw error;
      },
    });

    const response = await request(app).get('/api/audit').query({ url: 'https://down.example' }).expect(502);

    expect(response.body.error.code).toBe('UPSTREAM_UNREACHABLE');
  });

  it('rejects a document larger than the declared limit', async () => {
    app = buildApp({
      fetchImpl: stubFetch({
        '*': { body: 'x', headers: { 'content-type': 'text/html', 'content-length': '99999999' } },
      }),
    });

    const response = await request(app).get('/api/audit').query({ url: 'https://huge.example' }).expect(502);

    expect(response.body.error.code).toBe('UPSTREAM_TOO_LARGE');
  });

  it('truncates an undeclared oversized body instead of buffering it', async () => {
    // Streamed with no Content-Length: the cap has to be enforced while reading.
    const streamingFetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < 10; i += 1) controller.enqueue(encoder.encode('a'.repeat(500)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
    };

    app = buildApp({ fetchImpl: streamingFetch, env: { FETCH_MAX_BYTES: '1024' } });

    const response = await request(app).get('/api/audit').query({ url: 'https://big.example' }).expect(200);

    expect(response.body.result.http.truncated).toBe(true);
    expect(response.body.result.http.htmlBytes).toBe(1024);
  });
});

describe('redirects', () => {
  it('follows redirects and records the chain', async () => {
    app = buildApp({
      fetchImpl: stubFetch({
        'https://example.com/': { status: 301, headers: { location: 'https://www.example.com/home' } },
        'https://www.example.com/home': { body: GOOD_PAGE, headers: HTML_HEADERS },
      }),
    });

    const response = await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);

    expect(response.body.result.finalUrl).toBe('https://www.example.com/home');
    expect(response.body.result.http.redirects).toEqual([
      { from: 'https://example.com/', to: 'https://www.example.com/home', status: 301 },
    ]);
    expect(findCheck(response.body.result, 'redirect_chain_short').status).toBe('warn');
  });

  it('gives up on a redirect loop', async () => {
    app = buildApp({
      fetchImpl: stubFetch({ '*': (url) => ({ status: 302, headers: { location: `${url}?loop` } }) }),
      env: { FETCH_MAX_REDIRECTS: '3' },
    });

    const response = await request(app).get('/api/audit').query({ url: 'https://loop.example' }).expect(502);

    expect(response.body.error.code).toBe('TOO_MANY_REDIRECTS');
  });
});

describe('SSRF protection', () => {
  it('refuses a hostname that resolves to a private address', async () => {
    app = buildApp({ fetchImpl: stubFetch({ '*': { body: GOOD_PAGE } }), lookup: privateLookup });

    const response = await request(app).get('/api/audit').query({ url: 'https://internal.example' }).expect(403);

    expect(response.body.error.code).toBe('URL_NOT_ALLOWED');
  });

  it('refuses the cloud metadata address', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl });

    const response = await request(app)
      .get('/api/audit')
      .query({ url: 'http://169.254.169.254/latest/meta-data/' })
      .expect(403);

    expect(response.body.error.code).toBe('URL_NOT_ALLOWED');
    expect(fetchImpl.count()).toBe(0);
  });

  it('validates every redirect hop, not just the first URL', async () => {
    // The first hop is public; the target then bounces to loopback.
    app = buildApp({
      fetchImpl: stubFetch({
        'https://example.com/': { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } },
      }),
    });

    const response = await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(403);

    expect(response.body.error.code).toBe('URL_NOT_ALLOWED');
  });
});

function findCheck(result, id) {
  const check = result.checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`No check named ${id} in the report`);
  return check;
}
