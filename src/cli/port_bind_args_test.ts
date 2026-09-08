import { expect, test } from "bun:test";
import {
  parseBindArgs,
  parseBindSessionOnly,
  parseForwardArgs,
  parseForwardSessionOnly,
  parseUnbindArgs,
  parseUnforwardArgs,
} from "./port_bind_args.ts";

test("bind parses session, container port and optional host port", () => {
  expect(parseBindArgs(["abc123:3000"])).toEqual({
    sessionId: "abc123",
    containerPort: 3000,
    hostPort: null,
  });
  expect(parseBindArgs(["abc123:3000", "9000"])).toEqual({
    sessionId: "abc123",
    containerPort: 3000,
    hostPort: 9000,
  });
});

test("bind ignores flags and their values among the positionals", () => {
  expect(
    parseBindArgs([
      "--runtime-dir",
      "/tmp/x",
      "abc123:3000",
      "--format",
      "json",
    ]),
  ).toEqual({ sessionId: "abc123", containerPort: 3000, hostPort: null });
});

test("bind and unbind ignore global verbosity flags", () => {
  expect(parseBindArgs(["-q", "abc123:3000", "--verbose"])).toEqual({
    sessionId: "abc123",
    containerPort: 3000,
    hostPort: null,
  });
  expect(parseUnbindArgs(["--quiet", "-v", "9000"])).toEqual({
    hostPort: 9000,
  });
});

test("bind rejects a malformed key or an out-of-range port", () => {
  expect(() => parseBindArgs(["abc123"])).toThrow("session-id:container-port");
  expect(() => parseBindArgs(["abc123:0"])).toThrow("1-65535");
  expect(() => parseBindArgs(["abc123:70000"])).toThrow("1-65535");
});

test("bind rejects extra positionals", () => {
  expect(() => parseBindArgs(["abc123:3000", "9000", "extra"])).toThrow(
    "session-id:container-port",
  );
});

test("unbind accepts either key, or nothing", () => {
  expect(parseUnbindArgs(["abc123:3000"])).toEqual({
    sessionId: "abc123",
    containerPort: 3000,
  });
  expect(parseUnbindArgs(["9000"])).toEqual({ hostPort: 9000 });
  expect(parseUnbindArgs([])).toEqual(null);
});

test("unbind rejects malformed or extra positionals", () => {
  expect(() => parseUnbindArgs(["abc123:bad"])).toThrow("1-65535");
  expect(() => parseUnbindArgs(["9000", "extra"])).toThrow(
    "session-id:container-port",
  );
});

test("bind with only a session id asks for suggestions", () => {
  expect(parseBindSessionOnly(["abc123"])).toEqual("abc123");
  expect(parseBindSessionOnly(["--format", "json", "abc123"])).toEqual(
    "abc123",
  );
});

test("bind keeps a named target or a mistyped port out of suggestion mode", () => {
  expect(parseBindSessionOnly(["abc123:3000"])).toEqual(null);
  expect(parseBindSessionOnly(["3000"])).toEqual(null);
  expect(parseBindSessionOnly(["abc123", "9000"])).toEqual(null);
  expect(parseBindSessionOnly([])).toEqual(null);
});

test("forward parses the key and defaults the host port to the container port", () => {
  expect(parseForwardArgs(["abc123:5432"])).toEqual({
    sessionId: "abc123",
    containerPort: 5432,
    hostPort: 5432,
  });
  expect(parseForwardArgs(["abc123:5432", "15432", "--format=json"])).toEqual({
    sessionId: "abc123",
    containerPort: 5432,
    hostPort: 15432,
  });
  expect(() => parseForwardArgs(["abc123"])).toThrow("forward expects");
  expect(() => parseForwardArgs(["abc123:5432", "0"])).toThrow();
  expect(() => parseForwardArgs(["a:1", "2", "3"])).toThrow();
});

test("forward with only a session id asks for host suggestions", () => {
  expect(parseForwardSessionOnly(["abc123"])).toEqual("abc123");
  expect(parseForwardSessionOnly(["abc123:5432"])).toBeNull();
  expect(parseForwardSessionOnly(["5432"])).toBeNull();
  expect(parseForwardSessionOnly([])).toBeNull();
});

test("unforward takes a session key or nothing, never a bare port", () => {
  expect(parseUnforwardArgs(["abc123:5432"])).toEqual({
    sessionId: "abc123",
    containerPort: 5432,
  });
  expect(parseUnforwardArgs([])).toBeNull();
  expect(() => parseUnforwardArgs(["5432"])).toThrow("unforward expects");
  expect(() => parseUnforwardArgs(["a:1", "b:2"])).toThrow();
});
