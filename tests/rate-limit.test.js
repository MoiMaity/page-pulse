import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { buildApp, stubFetch, GOOD_PAGE } from './helpers.js';

let app;

const LIMITED = { RATE_LIMIT_MAX_REQUESTS: '3', RATE_LIMIT_WINDOW_SECONDS: '60' };

function makeApp(env = LIMITED) {
  app = buildApp({ fetchImpl: stubFetch({ '*': { body: GOOD_PAGE } }), env });
  return app;
}

afterEach(() => app?.locals.shutdown?.());

describe('per-client rate limiting', () => {
  it('advertises the limit and the remaining allowance', async () => {
    const response = await request(makeApp())
      .get('/api/audit')
      .query({ url: 'https://example.com' })
      .set('X-Forwarded-For', '203.0.113.10')
      .expect(200);

    expect(response.headers['ratelimit-limit']).toBe('3');
    expect(response.headers['ratelimit-remaining']).toBe('2');
    expect(Number(response.headers['ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('rejects requests past the limit with 429 and Retry-After', async () => {
    makeApp();
    const client = '203.0.113.11';

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .get('/api/audit')
        .query({ url: `https://example.com/${i}` })
        .set('X-Forwarded-For', client)
        .expect(200);
    }

    const blocked = await request(app)
      .get('/api/audit')
      .query({ url: 'https://example.com/4' })
      .set('X-Forwarded-For', client)
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.body.error.requestId).toBe(blocked.headers['x-request-id']);
  });

  it('counts each client separately', async () => {
    makeApp();

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .get('/api/audit')
        .query({ url: `https://example.com/${i}` })
        .set('X-Forwarded-For', '203.0.113.20')
        .expect(200);
    }

    await request(app)
      .get('/api/audit')
      .query({ url: 'https://example.com/other' })
      .set('X-Forwarded-For', '203.0.113.21')
      .expect(200);
  });

  it('keys on the API key when one is presented', async () => {
    makeApp();

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .get('/api/audit')
        .query({ url: `https://example.com/${i}` })
        .set('X-Forwarded-For', '203.0.113.30')
        .set('X-Api-Key', 'team-alpha')
        .expect(200);
    }

    // Same IP, different key: a fresh allowance.
    await request(app)
      .get('/api/audit')
      .query({ url: 'https://example.com/x' })
      .set('X-Forwarded-For', '203.0.113.30')
      .set('X-Api-Key', 'team-beta')
      .expect(200);
  });

  it('counts rejected requests too, so retries do not extend the window', async () => {
    makeApp({ ...LIMITED, RATE_LIMIT_MAX_REQUESTS: '1' });
    const client = '203.0.113.40';

    await request(app).get('/api/audit').query({ url: 'https://example.com' }).set('X-Forwarded-For', client).expect(200);
    await request(app).get('/api/audit').query({ url: 'https://example.com' }).set('X-Forwarded-For', client).expect(429);
    await request(app).get('/api/audit').query({ url: 'https://example.com' }).set('X-Forwarded-For', client).expect(429);
  });

  it('never throttles the liveness probe', async () => {
    makeApp({ ...LIMITED, RATE_LIMIT_MAX_REQUESTS: '1' });

    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/healthz').set('X-Forwarded-For', '203.0.113.50').expect(200);
    }
  });

  it('applies the limit before doing any outbound work', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl, env: { ...LIMITED, RATE_LIMIT_MAX_REQUESTS: '1' } });
    const client = '203.0.113.60';

    await request(app).get('/api/audit').query({ url: 'https://a.example' }).set('X-Forwarded-For', client).expect(200);
    await request(app).get('/api/audit').query({ url: 'https://b.example' }).set('X-Forwarded-For', client).expect(429);

    expect(fetchImpl.count()).toBe(1);
  });
});
