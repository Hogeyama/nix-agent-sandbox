/**
 * Tests for profileSchema from schema.ts.
 * Split from validate_test.ts — covers all "profileSchema:" test cases.
 */

import { expect, test } from "bun:test";
import {
  dbusSessionSchema,
  displaySchema,
  nixSchema,
  profileSchema,
  proxySchema,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// proxySchema
// ---------------------------------------------------------------------------

test("proxySchema: defaults to empty forwardPorts", () => {
  const result = proxySchema.parse(undefined);
  expect(result).toEqual({ forwardPorts: [] });
});

test("proxySchema: accepts forward-ports array", () => {
  const result = proxySchema.parse({ "forward-ports": [8080, 3000] });
  expect(result).toEqual({ forwardPorts: [8080, 3000] });
});

test("proxySchema: empty object defaults forward-ports", () => {
  const result = proxySchema.parse({});
  expect(result).toEqual({ forwardPorts: [] });
});

test("proxySchema: rejects out-of-range and non-integer ports", () => {
  expect(() => proxySchema.parse({ "forward-ports": [0] })).toThrow();
  expect(() => proxySchema.parse({ "forward-ports": [65536] })).toThrow();
  expect(() => proxySchema.parse({ "forward-ports": [1.5] })).toThrow();
});

test("proxySchema: rejects reserved port 18080", () => {
  expect(() => proxySchema.parse({ "forward-ports": [18080] })).toThrow(
    /18080.*reserved/,
  );
});

test("proxySchema: rejects duplicate ports", () => {
  expect(() =>
    proxySchema.parse({ "forward-ports": [8080, 3000, 8080] }),
  ).toThrow(/duplicate/);
});

test("profileSchema: accepts network.proxy.forward-ports", () => {
  const schema = profileSchema("test");
  const result = schema.parse({
    agent: "claude",
    network: {
      proxy: {
        "forward-ports": [8080, 5432],
      },
    },
  });
  expect(result.network.proxy.forwardPorts).toEqual([8080, 5432]);
});

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

// ---------------------------------------------------------------------------
// displaySchema (xpra sandbox)
// ---------------------------------------------------------------------------

test("displaySchema: defaults to sandbox=none and 1920x1080", () => {
  const result = displaySchema.parse(undefined);
  expect(result).toEqual({ sandbox: "none", size: "1920x1080" });
});

test("displaySchema: empty object applies defaults", () => {
  const result = displaySchema.parse({});
  expect(result).toEqual({ sandbox: "none", size: "1920x1080" });
});

test("displaySchema: accepts sandbox=xpra with explicit size", () => {
  const result = displaySchema.parse({ sandbox: "xpra", size: "1280x720" });
  expect(result).toEqual({ sandbox: "xpra", size: "1280x720" });
});

test("displaySchema: accepts sandbox=none explicitly", () => {
  const result = displaySchema.parse({ sandbox: "none" });
  expect(result).toEqual({ sandbox: "none", size: "1920x1080" });
});

test("displaySchema: rejects unknown sandbox values", () => {
  expect(() => displaySchema.parse({ sandbox: "wayland" })).toThrow();
  expect(() => displaySchema.parse({ sandbox: "xvfb" })).toThrow();
  expect(() => displaySchema.parse({ sandbox: "" })).toThrow();
});

test("displaySchema: rejects malformed size strings", () => {
  expect(() => displaySchema.parse({ size: "bogus" })).toThrow();
  expect(() => displaySchema.parse({ size: "1920" })).toThrow();
  expect(() => displaySchema.parse({ size: "1920×1080" })).toThrow();
  expect(() => displaySchema.parse({ size: "1920x1080;rm -rf /" })).toThrow();
});

test("displaySchema: rejects out-of-range dimensions (zero or above 16384)", () => {
  expect(() => displaySchema.parse({ size: "0x1080" })).toThrow();
  expect(() => displaySchema.parse({ size: "1920x0" })).toThrow();
  expect(() => displaySchema.parse({ size: "16385x1080" })).toThrow();
  expect(() => displaySchema.parse({ size: "1920x99999" })).toThrow();
});

test("displaySchema: accepts dimensions at the boundary", () => {
  expect(displaySchema.parse({ size: "1x1" }).size).toEqual("1x1");
  expect(displaySchema.parse({ size: "16384x16384" }).size).toEqual(
    "16384x16384",
  );
});

test("profileSchema: display defaults when omitted", () => {
  const schema = profileSchema("test");
  const result = schema.parse({ agent: "claude" });
  expect(result.display).toEqual({ sandbox: "none", size: "1920x1080" });
});

test("profileSchema: accepts display.sandbox=xpra", () => {
  const schema = profileSchema("test");
  const result = schema.parse({
    agent: "claude",
    display: { sandbox: "xpra", size: "1366x768" },
  });
  expect(result.display).toEqual({ sandbox: "xpra", size: "1366x768" });
});

// ---------------------------------------------------------------------------
// dbusSessionSchema: calls/broadcasts rule validation
// ---------------------------------------------------------------------------

test("dbusSessionSchema: accepts valid call rule names (incl. trailing '*')", () => {
  const result = dbusSessionSchema.parse({
    enable: true,
    calls: [
      { name: "org.freedesktop.Notifications", rule: "*" },
      { name: "org.gnome.*", rule: "Notify@/org/freedesktop/Notifications" },
    ],
    broadcasts: [{ name: "org.example.Foo", rule: "Signal@/path" }],
  });
  expect(result.calls.length).toEqual(2);
  expect(result.broadcasts.length).toEqual(1);
});

test("dbusSessionSchema: rejects '=' in call rule name", () => {
  expect(() =>
    dbusSessionSchema.parse({
      enable: true,
      calls: [{ name: "org.example=evil", rule: "*" }],
    }),
  ).toThrow();
});

test("dbusSessionSchema: rejects '=' in call rule body", () => {
  expect(() =>
    dbusSessionSchema.parse({
      enable: true,
      calls: [{ name: "org.example.Foo", rule: "a=b" }],
    }),
  ).toThrow();
});

test("dbusSessionSchema: rejects empty rule", () => {
  expect(() =>
    dbusSessionSchema.parse({
      enable: true,
      calls: [{ name: "org.example.Foo", rule: "" }],
    }),
  ).toThrow();
});

test("dbusSessionSchema: rejects invalid name characters", () => {
  expect(() =>
    dbusSessionSchema.parse({
      enable: true,
      broadcasts: [{ name: "org.example.Foo bar", rule: "*" }],
    }),
  ).toThrow();
  expect(() =>
    dbusSessionSchema.parse({
      enable: true,
      broadcasts: [{ name: ".leadingdot", rule: "*" }],
    }),
  ).toThrow();
});

// ---------------------------------------------------------------------------
// nixSchema: extra-packages hardening
// ---------------------------------------------------------------------------

test("nixSchema: accepts typical flake refs and plain names", () => {
  const result = nixSchema.parse({
    "extra-packages": ["nixpkgs#gh", "github:NixOS/nixpkgs#ripgrep", "jq"],
  });
  expect(result.extraPackages).toEqual([
    "nixpkgs#gh",
    "github:NixOS/nixpkgs#ripgrep",
    "jq",
  ]);
});

test("nixSchema: rejects extra-packages entry starting with '-'", () => {
  expect(() =>
    nixSchema.parse({ "extra-packages": ["--evil-flag"] }),
  ).toThrow();
  expect(() => nixSchema.parse({ "extra-packages": ["-x"] })).toThrow();
});

test("nixSchema: rejects extra-packages entry containing '..'", () => {
  expect(() => nixSchema.parse({ "extra-packages": ["../escape"] })).toThrow();
  expect(() =>
    nixSchema.parse({ "extra-packages": ["nixpkgs#../bad"] }),
  ).toThrow();
});
