/**
 * shellEscape is used to build shell command strings that dtach runs through
 * `/bin/sh -c`. Anything it passes to sh must round-trip safely; mistakes
 * here are shell-injection bugs, so edge cases are worth pinning down.
 */

import { expect, test } from "bun:test";
import { shellEscape } from "./client.ts";

test("shellEscape: leaves safe tokens untouched", () => {
  expect(shellEscape(["ls"])).toEqual("ls");
  expect(shellEscape(["ls", "-la", "/tmp"])).toEqual("ls -la /tmp");
  expect(shellEscape(["alpha", "beta_1", "path/to/file.txt"])).toEqual(
    "alpha beta_1 path/to/file.txt",
  );
});

test("shellEscape: safe charset includes = : @ - _ . /", () => {
  expect(shellEscape(["KEY=value", "user@host", "v1.2.3", "-flag"])).toEqual(
    "KEY=value user@host v1.2.3 -flag",
  );
});

test("shellEscape: quotes tokens containing whitespace", () => {
  expect(shellEscape(["hello world"])).toEqual("'hello world'");
});

test("shellEscape: quotes tokens containing shell metacharacters", () => {
  expect(shellEscape([";rm -rf /"])).toEqual("';rm -rf /'");
  expect(shellEscape(["$(whoami)"])).toEqual("'$(whoami)'");
  expect(shellEscape(["`id`"])).toEqual("'`id`'");
  expect(shellEscape(["a|b"])).toEqual("'a|b'");
  expect(shellEscape(["a&b"])).toEqual("'a&b'");
  expect(shellEscape(["a>b"])).toEqual("'a>b'");
  expect(shellEscape(["a*"])).toEqual("'a*'");
});

test("shellEscape: escapes embedded single quotes with '\\''", () => {
  // Input:   it's
  // Output:  'it'\''s'
  expect(shellEscape(["it's"])).toEqual("'it'\\''s'");
});

test("shellEscape: handles multiple embedded single quotes", () => {
  expect(shellEscape(["a'b'c"])).toEqual("'a'\\''b'\\''c'");
});

test("shellEscape: empty string becomes '' (explicit empty arg)", () => {
  // Empty string doesn't match the safe regex and gets quoted.
  expect(shellEscape([""])).toEqual("''");
});

test("shellEscape: empty array produces empty string", () => {
  expect(shellEscape([])).toEqual("");
});

test("shellEscape: mixed safe + unsafe tokens preserves boundaries", () => {
  expect(shellEscape(["echo", "hello world", "&&", "ls"])).toEqual(
    "echo 'hello world' '&&' ls",
  );
});

test("shellEscape: unicode characters are quoted (not in safe charset)", () => {
  expect(shellEscape(["日本語"])).toEqual("'日本語'");
});

test("shellEscape: tab and newline force quoting", () => {
  expect(shellEscape(["a\tb"])).toEqual("'a\tb'");
  expect(shellEscape(["a\nb"])).toEqual("'a\nb'");
});
