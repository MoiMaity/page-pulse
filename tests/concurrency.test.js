import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { Semaphore } from '../src/lib/semaphore.js';
import { buildApp, deferredFetch } from './helpers.js';

let app;

afterEach(() => app?.locals.shutdown?.());

describe('Semaphore', () => {
  it('never runs more than maxConcurrent tasks at once', async () => {
    const semaphore = new Semaphore({ maxConcurrent: 2 });
    let active = 0;
    let peak = 0;

    const task = () =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });

    await Promise.all(Array.from({ length: 10 }, task));

    expect(peak).toBe(2);
    expect(semaphore.stats().active).toBe(0);
  });

  it('queues waiters and hands slots on in order', async () => {
    const semaphore = new Semaphore({ maxConcurrent: 1 });
    const order = [];

    const first = await semaphore.acquire();
    const second = semaphore.acquire().then((release) => {
      order.push('second');
      release();
    });
    const third = semaphore.acquire().then((release) => {
      order.push('third');
      release();
    });

    expect(semaphore.stats().queued).toBe(2);
    first();
    await Promise.all([second, third]);

    expect(order).toEqual(['second', 'third']);
  });

  it('sheds load once the queue is full', async () => {
    const semaphore = new Semaphore({ maxConcurrent: 1, maxQueue: 1 });

    const release = await semaphore.acquire();
    semaphore.acquire(); // fills the queue

    await expect(semaphore.acquire()).rejects.toMatchObject({ status: 503, code: 'SERVER_BUSY' });
    expect(semaphore.stats().rejected).toBe(1);

    release();
  });

  it('tolerates a double release without corrupting the counter', async () => {
    const semaphore = new Semaphore({ maxConcurrent: 1 });
    const release = await semaphore.acquire();

    release();
    release();

    expect(semaphore.stats().active).toBe(0);
  });

  it('rejects an invalid configuration at construction time', () => {
    expect(() => new Semaphore({ maxConcurrent: 0 })).toThrow(TypeError);
  });
});

describe('audit concurrency limits', () => {
  it('answers 503 with Retry-After once the audit queue is full', async () => {
    const fetchImpl = deferredFetch();
    app = buildApp({ fetchImpl, env: { MAX_CONCURRENT_AUDITS: '1', MAX_QUEUED_AUDITS: '0' } });

    // Different URLs so single-flight cannot merge them.
    // .then() is what dispatches a supertest request, so start it explicitly.
    const first = request(app).get('/api/audit').query({ url: 'https://one.example' }).then((r) => r);
    await waitFor(() => fetchImpl.started === 1);

    const second = await request(app).get('/api/audit').query({ url: 'https://two.example' });

    expect(second.status).toBe(503);
    expect(second.body.error.code).toBe('SERVER_BUSY');
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);

    fetchImpl.release();
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it('queues rather than rejecting while the queue has room', async () => {
    const fetchImpl = deferredFetch();
    app = buildApp({ fetchImpl, env: { MAX_CONCURRENT_AUDITS: '1', MAX_QUEUED_AUDITS: '4' } });

    const first = request(app).get('/api/audit').query({ url: 'https://one.example' }).then((r) => r);
    await waitFor(() => fetchImpl.started === 1);
    const second = request(app).get('/api/audit').query({ url: 'https://two.example' }).then((r) => r);

    fetchImpl.release();

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
