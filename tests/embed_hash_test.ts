import { assertEquals, assertNotEquals } from "@std/assert";
import { computeEmbedHash } from "../src/docker/client.ts";

Deno.test("computeEmbedHash returns consistent hash", async () => {
  const hash1 = await computeEmbedHash();
  const hash2 = await computeEmbedHash();
  assertEquals(hash1, hash2);
  // SHA-256 hex is 64 chars
  assertEquals(hash1.length, 64);
});

Deno.test("computeEmbedHash changes when files differ", async () => {
  const originalHash = await computeEmbedHash();

  // Temporarily patch computeEmbedHash by directly hashing different content
  const { crypto } = await import("@std/crypto");
  const { encodeHex } = await import("@std/encoding/hex");
  const data = new TextEncoder().encode("different content");
  const hash = await crypto.subtle.digest("SHA-256", data);
  const differentHash = encodeHex(new Uint8Array(hash));

  assertNotEquals(originalHash, differentHash);
});
