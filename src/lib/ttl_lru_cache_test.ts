import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { TtlLruCache } from "./ttl_lru_cache.ts";

// ---------------------------------------------------------------------------
// Basic get / set
// ---------------------------------------------------------------------------

test("TtlLruCache: get returns undefined for missing key", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  expect(cache.get("x")).toEqual(undefined);
});

test("TtlLruCache: set then get returns value", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  cache.set("a", 1);
  expect(cache.get("a")).toEqual(1);
});

// ---------------------------------------------------------------------------
// maxSize eviction
// ---------------------------------------------------------------------------

test("TtlLruCache: evicts oldest entry when maxSize is exceeded", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 2, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3); // "a" should be evicted

  expect(cache.get("a")).toEqual(undefined);
  expect(cache.get("b")).toEqual(2);
  expect(cache.get("c")).toEqual(3);
  expect(cache.size).toEqual(2);
});

// ---------------------------------------------------------------------------
// LRU reorder on set (overwrite)
// ---------------------------------------------------------------------------

test("TtlLruCache: overwriting a key promotes it to most-recently-used", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 2, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  // Overwrite "a" — it is now the most-recently-used entry.
  cache.set("a", 10);
  // Inserting "c" should evict "b" (the oldest), not "a".
  cache.set("c", 3);

  expect(cache.get("b")).toEqual(undefined);
  expect(cache.get("a")).toEqual(10);
  expect(cache.get("c")).toEqual(3);
});

// ---------------------------------------------------------------------------
// LRU reorder on get (access)
// ---------------------------------------------------------------------------

test("TtlLruCache: get promotes entry to most-recently-used", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 2, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  // Access "a" — it moves to the tail.
  cache.get("a");
  // "b" is now the oldest; inserting "c" should evict it.
  cache.set("c", 3);

  expect(cache.get("b")).toEqual(undefined);
  expect(cache.get("a")).toEqual(1);
  expect(cache.get("c")).toEqual(3);
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

test("TtlLruCache: expired entries are removed on get", () => {
  // Use a very short TTL so the entry expires by the time we read it.
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 0 });
  cache.set("a", 1);
  // TTL is 0 ms, so the entry is already expired.
  expect(cache.get("a")).toEqual(undefined);
  expect(cache.size).toEqual(0);
});

// ---------------------------------------------------------------------------
// delete / clear / size
// ---------------------------------------------------------------------------

test("TtlLruCache: delete removes entry and returns boolean", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  cache.set("a", 1);
  expect(cache.delete("a")).toEqual(true);
  expect(cache.delete("a")).toEqual(false);
  expect(cache.get("a")).toEqual(undefined);
});

test("TtlLruCache: clear removes all entries", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  expect(cache.size).toEqual(0);
  expect(cache.get("a")).toEqual(undefined);
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test("TtlLruCache: throws RangeError when maxSize < 1", () => {
  expect(
    () => new TtlLruCache<string, number>({ maxSize: 0, ttlMs: 1000 }),
  ).toThrow("maxSize must be >= 1");
});

test("TtlLruCache: throws RangeError when ttlMs < 0", () => {
  expect(
    () => new TtlLruCache<string, number>({ maxSize: 1, ttlMs: -1 }),
  ).toThrow("ttlMs must be >= 0");
});

test("TtlLruCache: size reflects current entry count", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  expect(cache.size).toEqual(0);
  cache.set("a", 1);
  expect(cache.size).toEqual(1);
  cache.set("b", 2);
  expect(cache.size).toEqual(2);
  cache.delete("a");
  expect(cache.size).toEqual(1);
});
