import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { buildApp, stubFetch, GOOD_PAGE } from './helpers.js';

let app;
let fetchImpl;

function makeApp() {
  fetchImpl = stubFetch({ '*': { body: GOOD_PAGE } });
  app = buildApp({ fetchImpl });
  return app;
}

afterEach(() => app?.locals.shutdown?.());

describe('POST/GET /api/audit input validation', () => {
  it('rejects a missing url with field-level details', async () => {
    const response = await request(makeApp()).post('/api/audit').send({}).expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'url' }),
    );
    expect(fetchImpl.count()).toBe(0);
  });

  it('rejects an empty url', async () => {
    const response = await request(makeApp()).get('/api/audit').query({ url: '   ' }).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unknown parameters instead of ignoring them', async () => {
    const response = await request(makeApp())
      .post('/api/audit')
      .send({ url: 'https://example.com', follow: true })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-numeric maxAge', async () => {
    const response = await request(makeApp())
      .get('/api/audit')
      .query({ url: 'https://example.com', maxAge: 'forever' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a maxAge beyond the accepted range', async () => {
    const response = await request(makeApp())
      .get('/api/audit')
      .query({ url: 'https://example.com', maxAge: 999999 })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unparsable URLs', async () => {
    const response = await request(makeApp()).get('/api/audit').query({ url: 'not a url' }).expect(400);

    expect(response.body.error.code).toBe('INVALID_URL');
    expect(fetchImpl.count()).toBe(0);
  });

  it('rejects non-http protocols', async () => {
    const response = await request(makeApp())
      .get('/api/audit')
      .query({ url: 'ftp://example.com/file.txt' })
      .expect(400);

    expect(response.body.error.code).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('rejects URLs carrying embedded credentials', async () => {
    const response = await request(makeApp())
      .get('/api/audit')
      .query({ url: 'https://admin:hunter2@example.com' })
      .expect(403);

    expect(response.body.error.code).toBe('URL_NOT_ALLOWED');
  });

  it('accepts a bare hostname and upgrades it to https', async () => {
    const response = await request(makeApp()).get('/api/audit').query({ url: 'example.com/pricing' }).expect(200);

    expect(response.body.result.requestedUrl).toBe('https://example.com/pricing');
  });

  it('rejects a malformed JSON body with a distinct code', async () => {
    const response = await request(makeApp())
      .post('/api/audit')
      .set('Content-Type', 'application/json')
      .send('{"url": ')
      .expect(400);

    expect(response.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects an oversized body', async () => {
    const response = await request(makeApp())
      .post('/api/audit')
      .send({ url: 'https://example.com', padding: 'x'.repeat(20_000) })
      .expect(413);

    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
