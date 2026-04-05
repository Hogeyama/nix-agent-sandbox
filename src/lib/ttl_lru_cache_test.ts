import { assertEquals, assertThrows } from "@std/assert";
import { TtlLruCache } from "./ttl_lru_cache.ts";

// ---------------------------------------------------------------------------
// Basic get / set
// ---------------------------------------------------------------------------

Deno.test("TtlLruCache: get returns undefined for missing key", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  assertEquals(cache.get("x"), undefined);
});

Deno.test("TtlLruCache: set then get returns value", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  cache.set("a", 1);
  assertEquals(cache.get("a"), 1);
});

// ---------------------------------------------------------------------------
// maxSize eviction
// ---------------------------------------------------------------------------

Deno.test("TtlLruCache: evicts oldest entry when maxSize is exceeded", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 2, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3); // "a" should be evicted

  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), 2);
  assertEquals(cache.get("c"), 3);
  assertEquals(cache.size, 2);
});

// ---------------------------------------------------------------------------
// LRU reorder on set (overwrite)
// ---------------------------------------------------------------------------

Deno.test("TtlLruCache: overwriting a key promotes it to most-recently-used", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 2, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  // Overwrite "a" — it is now the most-recently-used entry.
  cache.set("a", 10);
  // Inserting "c" should evict "b" (the oldest), not "a".
  cache.set("c", 3);

  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("a"), 10);
  assertEquals(cache.get("c"), 3);
});

// ---------------------------------------------------------------------------
// LRU reorder on get (access)
// ---------------------------------------------------------------------------

Deno.test("TtlLruCache: get promotes entry to most-recently-used", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 2, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  // Access "a" — it moves to the tail.
  cache.get("a");
  // "b" is now the oldest; inserting "c" should evict it.
  cache.set("c", 3);

  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("a"), 1);
  assertEquals(cache.get("c"), 3);
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

Deno.test("TtlLruCache: expired entries are removed on get", () => {
  // Use a very short TTL so the entry expires by the time we read it.
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 0 });
  cache.set("a", 1);
  // TTL is 0 ms, so the entry is already expired.
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.size, 0);
});

// ---------------------------------------------------------------------------
// delete / clear / size
// ---------------------------------------------------------------------------

Deno.test("TtlLruCache: delete removes entry and returns boolean", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  cache.set("a", 1);
  assertEquals(cache.delete("a"), true);
  assertEquals(cache.delete("a"), false);
  assertEquals(cache.get("a"), undefined);
});

Deno.test("TtlLruCache: clear removes all entries", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assertEquals(cache.size, 0);
  assertEquals(cache.get("a"), undefined);
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

Deno.test("TtlLruCache: throws RangeError when maxSize < 1", () => {
  assertThrows(
    () => new TtlLruCache<string, number>({ maxSize: 0, ttlMs: 1000 }),
    RangeError,
    "maxSize must be >= 1",
  );
});

Deno.test("TtlLruCache: throws RangeError when ttlMs < 0", () => {
  assertThrows(
    () => new TtlLruCache<string, number>({ maxSize: 1, ttlMs: -1 }),
    RangeError,
    "ttlMs must be >= 0",
  );
});

Deno.test("TtlLruCache: size reflects current entry count", () => {
  const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 60_000 });
  assertEquals(cache.size, 0);
  cache.set("a", 1);
  assertEquals(cache.size, 1);
  cache.set("b", 2);
  assertEquals(cache.size, 2);
  cache.delete("a");
  assertEquals(cache.size, 1);
});
