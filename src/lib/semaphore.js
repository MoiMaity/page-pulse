import { serverBusy } from './errors.js';

/**
 * Counting semaphore with a bounded wait queue.
 *
 * Bounded is the important part: an unbounded queue turns a traffic spike into
 * unbounded memory growth and unbounded latency. When the queue is full we
 * shed load immediately with a 503 and a Retry-After, which is a far better
 * failure mode than a slow death.
 */
export class Semaphore {
  /**
   * @param {{ maxConcurrent: number, maxQueue?: number }} options
   */
  constructor({ maxConcurrent, maxQueue = Number.POSITIVE_INFINITY }) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError('maxConcurrent must be a positive integer');
    }
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.active = 0;
    /** @type {Array<(release: () => void) => void>} */
    this.queue = [];
    this.rejected = 0;
  }

  /**
   * Resolves with a release function. Always release in a `finally` block.
   * @returns {Promise<() => void>}
   */
  acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.#makeRelease());
    }

    if (this.queue.length >= this.maxQueue) {
      this.rejected += 1;
      return Promise.reject(serverBusy());
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Convenience wrapper: acquire, run, always release.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #makeRelease() {
    let released = false;
    return () => {
      if (released) return; // double-release must not corrupt the counter
      released = true;

      const next = this.queue.shift();
      if (next) {
        // Hand the slot straight to the next waiter; `active` stays the same.
        next(this.#makeRelease());
      } else {
        this.active -= 1;
      }
    };
  }

  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue === Number.POSITIVE_INFINITY ? null : this.maxQueue,
      rejected: this.rejected,
    };
  }
}
