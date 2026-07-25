import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { buildApp, stubFetch, GOOD_PAGE } from './helpers.js';
import { TtlCache } from '../src/lib/cache.js';

let app;

afterEach(() => app?.locals.shutdown?.());

describe('audit caching', () => {
  it('serves a repeat audit from cache without refetching', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl });

    const first = await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);
    const second = await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body.cache).toMatchObject({ hit: true, ageSeconds: expect.any(Number) });
    expect(second.body.result.fetchedAt).toBe(first.body.result.fetchedAt);
    expect(fetchImpl.count()).toBe(1);
  });

  it('treats URLs differing only by fragment as the same entry', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl });

    await request(app).get('/api/audit').query({ url: 'https://example.com/pricing#plans' }).expect(200);
    const second = await request(app).get('/api/audit').query({ url: 'https://example.com/pricing' }).expect(200);

    expect(second.headers['x-cache']).toBe('HIT');
    expect(fetchImpl.count()).toBe(1);
  });

  it('treats different query strings as different entries', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl });

    await request(app).get('/api/audit').query({ url: 'https://example.com/?a=1' }).expect(200);
    const second = await request(app).get('/api/audit').query({ url: 'https://example.com/?a=2' }).expect(200);

    expect(second.headers['x-cache']).toBe('MISS');
    expect(fetchImpl.count()).toBe(2);
  });

  it('refetches when fresh=true', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl });

    await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);
    const forced = await request(app)
      .get('/api/audit')
      .query({ url: 'https://example.com', fresh: 'true' })
      .expect(200);

    expect(forced.headers['x-cache']).toBe('MISS');
    expect(fetchImpl.count()).toBe(2);
  });

  it('honours a per-request maxAge narrower than the server default', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl, env: { CACHE_TTL_SECONDS: '600' } });

    await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);
    // maxAge=0 means "nothing cached is acceptable".
    const strict = await request(app)
      .get('/api/audit')
      .query({ url: 'https://example.com', maxAge: 0 })
      .expect(200);

    expect(strict.headers['x-cache']).toBe('MISS');
    expect(fetchImpl.count()).toBe(2);
  });

  it('caches nothing when the window is configured to zero', async () => {
    const fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
    app = buildApp({ fetchImpl, env: { CACHE_TTL_SECONDS: '0' } });

    await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);
    const second = await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);

    expect(second.headers['x-cache']).toBe('MISS');
    expect(fetchImpl.count()).toBe(2);
  });

  it('reports the configured window in the response', async () => {
    app = buildApp({ fetchImpl: stubFetch({ '*': { body: GOOD_PAGE } }), env: { CACHE_TTL_SECONDS: '45' } });

    const response = await request(app).get('/api/audit').query({ url: 'https://example.com' }).expect(200);

    expect(response.body.cache.windowSeconds).toBe(45);
  });

  it('collapses concurrent audits of the same URL into one fetch', async () => {
    const fetchImpl = stubFetch({
      '*': async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { body: GOOD_PAGE };
      },
    });
    app = buildApp({ fetchImpl });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(app).get('/api/audit').query({ url: 'https://example.com' })),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(fetchImpl.count()).toBe(1);
  });
});

describe('TtlCache', () => {
  it('expires entries once the TTL has passed', () => {
    let now = 1_000;
    const cache = new TtlCache({ now: () => now });

    cache.set('a', 'value', 100);
    expect(cache.get('a').value).toBe('value');

    now += 101;
    expect(cache.get('a')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('reports the age of a stored entry', () => {
    let now = 0;
    const cache = new TtlCache({ now: () => now });

    cache.set('a', 1, 1000);
    now = 250;

    expect(cache.get('a').ageMs).toBe(250);
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new TtlCache({ maxEntries: 2 });

    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    cache.get('a'); // 'a' is now the most recently used
    cache.set('c', 3, 1000);

    expect(cache.get('b')).toBeNull();
    expect(cache.get('a').value).toBe(1);
    expect(cache.get('c').value).toBe(3);
    expect(cache.stats().evictions).toBe(1);
  });

  it('ignores writes with a non-positive TTL', () => {
    const cache = new TtlCache();
    cache.set('a', 1, 0);
    expect(cache.get('a')).toBeNull();
  });

  it('tracks a hit ratio', () => {
    const cache = new TtlCache();
    cache.set('a', 1, 1000);
    cache.get('a');
    cache.get('missing');

    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, hitRatio: 0.5 });
  });
});
