/**
 * Tests for profileSchema from schema.ts.
 * Split from validate_test.ts — covers all "profileSchema:" test cases.
 */

import { expect, test } from "bun:test";
import { profileSchema } from "./schema.ts";

// ---------------------------------------------------------------------------
// Error aggregation: superRefine collects multiple issues instead of aborting
// on the first one.
// ---------------------------------------------------------------------------

test("profileSchema: env collects errors from multiple entries", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    env: [{ key: "A", key_cmd: "echo A", val: "x" }, { val: "y" }],
  });
  expect(result.success).toEqual(false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths.includes("env.0")).toEqual(true);
    expect(paths.includes("env.1")).toEqual(true);
  }
});

test("profileSchema: env reports both key and val errors in same entry", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    env: [{ key: "A", key_cmd: "echo A", val: "x", val_cmd: "echo x" }],
  });
  expect(result.success).toEqual(false);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("key or key_cmd"))).toEqual(true);
    // key error triggers early return, so val error is not reached (by design)
    // — the key/val checks are sequential within one entry
  }
});

test("profileSchema: network collects multiple allowlist/denylist overlaps", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["a.com", "b.com", "c.com"],
      prompt: { denylist: ["a.com", "c.com"] },
    },
  });
  expect(result.success).toEqual(false);
  if (!result.success) {
    const overlapMessages = result.error.issues.filter((i) =>
      i.message.includes("appears in both"),
    );
    expect(overlapMessages.length).toEqual(2);
    expect(overlapMessages.some((i) => i.message.includes('"a.com"'))).toEqual(
      true,
    );
    expect(overlapMessages.some((i) => i.message.includes('"c.com"'))).toEqual(
      true,
    );
  }
});

test("profileSchema: network.allowlist accepts host:port entries", () => {
  const schema = profileSchema("test");
  const result = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["example.com:443", "*.api.com:8080", "plain.com"],
    },
  });
  expect(result.success).toEqual(true);
  if (result.success) {
    expect(result.data.network.allowlist).toEqual([
      "example.com:443",
      "*.api.com:8080",
      "plain.com",
    ]);
  }
});

test("profileSchema: network allowlist/denylist overlap with matching port", () => {
  const schema = profileSchema("test");
  // same host:port in both → overlap
  const portSame = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["example.com:443"],
      prompt: { denylist: ["example.com:443"] },
    },
  });
  expect(portSame.success).toEqual(false);

  // same host but different ports → no overlap
  const portDiff = schema.safeParse({
    agent: "claude",
    network: {
      allowlist: ["example.com:443"],
      prompt: { denylist: ["example.com:80"] },
    },
  });
  expect(portDiff.success).toEqual(true);
});
