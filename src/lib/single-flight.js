/**
 * Collapses concurrent work for the same key into one execution.
 *
 * A cache alone does not protect the target site: ten simultaneous audits of
 * the same cold URL would all miss the cache and all fetch. With single-flight
 * the first caller does the work and the other nine await the same promise.
 */
export class SingleFlight {
  constructor() {
    /** @type {Map<string, Promise<any>>} */
    this.inFlight = new Map();
    this.coalesced = 0;
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<{ value: T, coalesced: boolean }>}
   */
  async run(key, fn) {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.coalesced += 1;
      return { value: await existing, coalesced: true };
    }

    const promise = (async () => fn())();
    this.inFlight.set(key, promise);

    try {
      return { value: await promise, coalesced: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  get size() {
    return this.inFlight.size;
  }

  stats() {
    return { inFlight: this.inFlight.size, coalesced: this.coalesced };
  }
}
