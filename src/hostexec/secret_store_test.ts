/**
 * Pure-helper tests for secret_store: path safety and dotenv parsing.
 *
 * assertSafeSecretPath gates file: / dotenv: secret sources, so mistakes
 * here would be a sandbox-escape vector. Worth pinning down exhaustively.
 */

import { expect, test } from "bun:test";
import { assertSafeSecretPath, parseDotEnv } from "./secret_store.ts";

// ---------------------------------------------------------------------------
// assertSafeSecretPath — positive cases
// ---------------------------------------------------------------------------

test("assertSafeSecretPath: allows paths within HOME", () => {
  expect(() =>
    assertSafeSecretPath("/home/alice/.secrets/token", {
      HOME: "/home/alice",
    }),
  ).not.toThrow();
});

test("assertSafeSecretPath: allows paths within XDG_CONFIG_HOME", () => {
  expect(() =>
    assertSafeSecretPath("/home/alice/.config/nas/token", {
      HOME: "/unused",
      XDG_CONFIG_HOME: "/home/alice/.config",
    }),
  ).not.toThrow();
});

test("assertSafeSecretPath: allows /var/lib/<user>/subdir", () => {
  // /var/lib is sensitive, but /var/lib/<user>/... is allowed.
  expect(() =>
    assertSafeSecretPath("/var/lib/myservice/secrets/token", {
      HOME: "/home/alice",
    }),
  ).not.toThrow();
});

test("assertSafeSecretPath: allows /root as HOME", () => {
  expect(() =>
    assertSafeSecretPath("/root/.token", {
      HOME: "/root",
    }),
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// assertSafeSecretPath — negative cases
// ---------------------------------------------------------------------------

test("assertSafeSecretPath: empty path throws", () => {
  expect(() => assertSafeSecretPath("", { HOME: "/home/a" })).toThrow(
    /must not be empty/,
  );
});

test("assertSafeSecretPath: '..' segments rejected before resolve", () => {
  expect(() =>
    assertSafeSecretPath("/home/alice/../etc/shadow", { HOME: "/home/alice" }),
  ).toThrow(/\.\./);
});

test("assertSafeSecretPath: rejects /etc paths", () => {
  expect(() =>
    assertSafeSecretPath("/etc/shadow", { HOME: "/home/alice" }),
  ).toThrow(/\/etc/);
});

test("assertSafeSecretPath: rejects other sensitive prefixes", () => {
  for (const p of [
    "/proc/self/environ",
    "/sys/class",
    "/dev/random",
    "/boot/grub",
    "/var/log/auth.log",
  ]) {
    expect(() => assertSafeSecretPath(p, { HOME: "/home/alice" })).toThrow();
  }
});

test("assertSafeSecretPath: rejects /root when HOME is elsewhere", () => {
  expect(() =>
    assertSafeSecretPath("/root/secret", { HOME: "/home/alice" }),
  ).toThrow(/\/root/);
});

test("assertSafeSecretPath: rejects bare /var/lib/file (needs <user>/subdir)", () => {
  expect(() =>
    assertSafeSecretPath("/var/lib/token", { HOME: "/home/a" }),
  ).toThrow(/\/var\/lib/);
});

test("assertSafeSecretPath: rejects /var/lib/onlyuser (<2 segments)", () => {
  // Exactly one segment beneath /var/lib is treated as a bare dir and rejected.
  expect(() =>
    assertSafeSecretPath("/var/lib/onlyuser", { HOME: "/home/a" }),
  ).toThrow(/\/var\/lib/);
});

// ---------------------------------------------------------------------------
// parseDotEnv
// ---------------------------------------------------------------------------

test("parseDotEnv: basic KEY=VALUE", () => {
  expect(parseDotEnv("FOO=bar\nBAZ=qux\n")).toEqual({
    FOO: "bar",
    BAZ: "qux",
  });
});

test("parseDotEnv: trims surrounding whitespace around key and value", () => {
  expect(parseDotEnv("  FOO  =  bar  \n")).toEqual({ FOO: "bar" });
});

test("parseDotEnv: strips 'export ' prefix", () => {
  expect(parseDotEnv("export FOO=bar\n")).toEqual({ FOO: "bar" });
});

test('parseDotEnv: strips double quotes and interprets \\" and \\\\', () => {
  expect(parseDotEnv('FOO="he said \\"hi\\""\n')).toEqual({
    FOO: 'he said "hi"',
  });
  expect(parseDotEnv('FOO="a\\\\b"\n')).toEqual({ FOO: "a\\b" });
});

test("parseDotEnv: strips single quotes but does NOT interpret escapes", () => {
  expect(parseDotEnv("FOO='raw\\nvalue'\n")).toEqual({ FOO: "raw\\nvalue" });
});

test("parseDotEnv: ignores comments and blank lines", () => {
  expect(
    parseDotEnv("# comment\n\nFOO=bar\n  # indented comment\nBAZ=qux\n"),
  ).toEqual({ FOO: "bar", BAZ: "qux" });
});

test("parseDotEnv: handles CRLF line endings", () => {
  expect(parseDotEnv("FOO=bar\r\nBAZ=qux\r\n")).toEqual({
    FOO: "bar",
    BAZ: "qux",
  });
});

test("parseDotEnv: ignores lines with no equals sign", () => {
  expect(parseDotEnv("FOO\nBAR=baz\n")).toEqual({ BAR: "baz" });
});

test("parseDotEnv: ignores lines starting with '='", () => {
  // equalsIndex <= 0 → skipped
  expect(parseDotEnv("=bad\nFOO=ok\n")).toEqual({ FOO: "ok" });
});

test("parseDotEnv: last value wins when a key is repeated", () => {
  expect(parseDotEnv("FOO=first\nFOO=second\n")).toEqual({ FOO: "second" });
});

test("parseDotEnv: value may contain '='", () => {
  expect(parseDotEnv("KEY=a=b=c\n")).toEqual({ KEY: "a=b=c" });
});

test("parseDotEnv: empty value becomes empty string", () => {
  expect(parseDotEnv("FOO=\n")).toEqual({ FOO: "" });
});
