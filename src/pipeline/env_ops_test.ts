import { expect, test } from "bun:test";
import { encodeDynamicEnvOps } from "./env_ops.ts";
import type { DynamicEnvOp } from "./state.ts";

test("encodeDynamicEnvOps: empty ops returns empty string", () => {
  expect(encodeDynamicEnvOps([])).toEqual("");
});

test("encodeDynamicEnvOps: single prefix op", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "prefix", key: "PATH", value: "/usr/local/bin", separator: ":" },
  ];
  expect(encodeDynamicEnvOps(ops)).toEqual(
    "__nas_pfx 'PATH' '/usr/local/bin' ':'",
  );
});

test("encodeDynamicEnvOps: single suffix op", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "suffix", key: "PATH", value: "/opt/bin", separator: ":" },
  ];
  expect(encodeDynamicEnvOps(ops)).toEqual("__nas_sfx 'PATH' '/opt/bin' ':'");
});

test("encodeDynamicEnvOps: multiple ops joined by newline", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "prefix", key: "PATH", value: "/a", separator: ":" },
    { mode: "suffix", key: "MANPATH", value: "/b", separator: ":" },
  ];
  const result = encodeDynamicEnvOps(ops);
  const lines = result.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toEqual("__nas_pfx 'PATH' '/a' ':'");
  expect(lines[1]).toEqual("__nas_sfx 'MANPATH' '/b' ':'");
});

test("encodeDynamicEnvOps: single quotes in value are escaped", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "prefix", key: "KEY", value: "it's here", separator: ":" },
  ];
  expect(encodeDynamicEnvOps(ops)).toEqual(
    "__nas_pfx 'KEY' 'it'\\''s here' ':'",
  );
});

// ---------------------------------------------------------------------------
// Key validation — regression for shell-abort under set -euo pipefail
// ---------------------------------------------------------------------------

test("encodeDynamicEnvOps: throws on key with dash", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "prefix", key: "BAD-NAME", value: "/x", separator: ":" },
  ];
  expect(() => encodeDynamicEnvOps(ops)).toThrow("BAD-NAME");
});

test("encodeDynamicEnvOps: throws on key starting with digit", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "suffix", key: "1BAD", value: "/x", separator: ":" },
  ];
  expect(() => encodeDynamicEnvOps(ops)).toThrow("1BAD");
});

test("encodeDynamicEnvOps: throws on empty key", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "prefix", key: "", value: "/x", separator: ":" },
  ];
  expect(() => encodeDynamicEnvOps(ops)).toThrow();
});

test("encodeDynamicEnvOps: throws on key with dot", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "prefix", key: "MY.VAR", value: "/x", separator: ":" },
  ];
  expect(() => encodeDynamicEnvOps(ops)).toThrow("MY.VAR");
});

test("encodeDynamicEnvOps: throws on second op with invalid key", () => {
  const ops: DynamicEnvOp[] = [
    { mode: "prefix", key: "VALID", value: "/a", separator: ":" },
    { mode: "suffix", key: "BAD NAME", value: "/b", separator: ":" },
  ];
  expect(() => encodeDynamicEnvOps(ops)).toThrow("BAD NAME");
});
