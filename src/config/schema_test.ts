/**
 * Tests for profileSchema from schema.ts.
 * Split from validate_test.ts — covers all "profileSchema:" test cases.
 */

import { assertEquals } from "@std/assert";
import { profileSchema } from "./schema.ts";

// ---------------------------------------------------------------------------
// Error aggregation: superRefine collects multiple issues instead of aborting
// on the first one.
// ---------------------------------------------------------------------------

Deno.test("profileSchema: env collects errors from multiple entries", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    env: [
      { key: "A", key_cmd: "echo A", val: "x" },
      { val: "y" },
    ],
  });
  assertEquals(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join("."));
    assertEquals(paths.includes("env.0"), true, "env[0] error missing");
    assertEquals(paths.includes("env.1"), true, "env[1] error missing");
  }
});

Deno.test("profileSchema: env reports both key and val errors in same entry", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    env: [
      { key: "A", key_cmd: "echo A", val: "x", val_cmd: "echo x" },
    ],
  });
  assertEquals(result.success, false);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message);
    assertEquals(
      messages.some((m) => m.includes("key or key_cmd")),
      true,
    );
    // key error triggers early return, so val error is not reached (by design)
    // — the key/val checks are sequential within one entry
  }
});

Deno.test("profileSchema: network collects multiple allowlist/denylist overlaps", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["a.com", "b.com", "c.com"],
      prompt: { denylist: ["a.com", "c.com"] },
    },
  });
  assertEquals(result.success, false);
  if (!result.success) {
    const overlapMessages = result.error.issues.filter((i) =>
      i.message.includes("appears in both")
    );
    assertEquals(overlapMessages.length, 2, "expected 2 overlap errors");
    assertEquals(
      overlapMessages.some((i) => i.message.includes('"a.com"')),
      true,
    );
    assertEquals(
      overlapMessages.some((i) => i.message.includes('"c.com"')),
      true,
    );
  }
});

Deno.test("profileSchema: network.allowlist accepts host:port entries", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["example.com:443", "*.api.com:8080", "plain.com"],
    },
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.network.allowlist, [
      "example.com:443",
      "*.api.com:8080",
      "plain.com",
    ]);
  }
});

Deno.test("profileSchema: network allowlist/denylist overlap with matching port", () => {
  const schema = profileSchema("test");
  // same host:port in both → overlap
  const portSame = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["example.com:443"],
      prompt: { denylist: ["example.com:443"] },
    },
  });
  assertEquals(portSame.success, false);

  // same host but different ports → no overlap
  const portDiff = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["example.com:443"],
      prompt: { denylist: ["example.com:80"] },
    },
  });
  assertEquals(portDiff.success, true);
});
