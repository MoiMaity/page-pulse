/**
 * Small in-process cache with per-entry TTL and LRU eviction.
 *
 * Deliberately dependency-free and single-node. If Page Pulse is ever scaled
 * horizontally this is the one module to swap for Redis — the interface
 * (get/set/delete/stats) is intentionally small enough to reimplement.
 */
export class TtlCache {
  /**
   * @param {{ maxEntries?: number, defaultTtlMs?: number, now?: () => number }} [options]
   */
  constructor({ maxEntries = 500, defaultTtlMs = 300_000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.now = now;
    /** @type {Map<string, { value: unknown, storedAt: number, expiresAt: number }>} */
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * @param {string} key
   * @returns {{ value: any, ageMs: number, storedAt: number, expiresAt: number } | null}
   */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }

    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }

    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;

    return {
      value: entry.value,
      ageMs: now - entry.storedAt,
      storedAt: entry.storedAt,
      expiresAt: entry.expiresAt,
    };
  }

  /**
   * @param {string} key
   * @param {any} value
   * @param {number} [ttlMs]
   */
  set(key, value, ttlMs = this.defaultTtlMs) {
    if (ttlMs <= 0) return;

    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }

  delete(key) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }

  stats() {
    const lookups = this.hits + this.misses;
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRatio: lookups === 0 ? 0 : Number((this.hits / lookups).toFixed(4)),
    };
  }
}
