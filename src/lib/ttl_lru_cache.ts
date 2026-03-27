/**
 * A simple TTL-aware LRU cache backed by a `Map`.
 *
 * - Entries that exceed `ttlMs` are lazily evicted on `get`.
 * - When `maxSize` is reached, the least-recently-used entry (the Map's
 *   iteration-order head) is evicted on `set`.
 * - `set` and `get` both refresh an entry's LRU position.
 */
export class TtlLruCache<K, V> {
  readonly #maxSize: number;
  readonly #ttlMs: number;
  readonly #entries: Map<K, { value: V; expiresAt: number }>;

  constructor(opts: { maxSize: number; ttlMs: number }) {
    if (opts.maxSize < 1) {
      throw new RangeError("maxSize must be >= 1");
    }
    if (opts.ttlMs < 0) {
      throw new RangeError("ttlMs must be >= 0");
    }
    this.#maxSize = opts.maxSize;
    this.#ttlMs = opts.ttlMs;
    this.#entries = new Map();
  }

  /** Return the cached value, or `undefined` if missing / expired. */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;

    if (Date.now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }

    // Move to tail (most-recently-used).
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** Insert or update a key. Resets TTL and promotes to most-recently-used. */
  set(key: K, value: V): void {
    // Remove first so re-insert goes to the tail.
    this.#entries.delete(key);

    // Evict the least-recently-used entry when at capacity.
    if (this.#entries.size >= this.#maxSize) {
      const { value: oldest, done } = this.#entries.keys().next();
      if (!done) {
        this.#entries.delete(oldest);
      }
    }

    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }

  /** Remove a single entry. Returns `true` if the key existed. */
  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.#entries.clear();
  }

  /** Number of entries currently stored (including possibly-expired ones). */
  get size(): number {
    return this.#entries.size;
  }
}
