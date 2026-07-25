import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { buildApp, stubFetch, GOOD_PAGE } from './helpers.js';

let app;

afterEach(() => app?.locals.shutdown?.());

describe('operational endpoints', () => {
  it('reports liveness without touching the network', async () => {
    app = buildApp({ fetchImpl: stubFetch({}) });

    const response = await request(app).get('/healthz').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body).toHaveProperty('uptimeSeconds');
    expect(response.body.env).toBe('test');
  });

  it('exposes cache, queue and rate limit internals', async () => {
    app = buildApp({ fetchImpl: stubFetch({ '*': { body: GOOD_PAGE } }) });

    await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);
    const response = await request(app).get('/api/stats').expect(200);

    expect(response.body.cache.size).toBe(1);
    expect(response.body.concurrency).toMatchObject({ active: 0, maxConcurrent: expect.any(Number) });
    expect(response.body.rateLimit.trackedClients).toBeGreaterThan(0);
  });
});

describe('request identity', () => {
  it('generates a request ID and echoes it on the response', async () => {
    app = buildApp({ fetchImpl: stubFetch({}) });

    const response = await request(app).get('/healthz').expect(200);

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses a well-formed request ID supplied by the edge', async () => {
    app = buildApp({ fetchImpl: stubFetch({}) });

    const response = await request(app).get('/healthz').set('X-Request-Id', 'edge-abc-123').expect(200);

    expect(response.headers['x-request-id']).toBe('edge-abc-123');
  });

  it('ignores a malformed inbound request ID', async () => {
    app = buildApp({ fetchImpl: stubFetch({}) });

    const response = await request(app).get('/healthz').set('X-Request-Id', 'no').expect(200);

    expect(response.headers['x-request-id']).not.toBe('no');
  });
});

describe('unknown routes', () => {
  it('answers with the standard error envelope', async () => {
    app = buildApp({ fetchImpl: stubFetch({}) });

    const response = await request(app).get('/api/nope').expect(404);

    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    expect(response.body.error.timestamp).toEqual(expect.any(String));
  });
});
