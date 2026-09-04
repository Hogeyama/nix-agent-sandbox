import { expect, test } from "bun:test";
import { parseBindArgs, parseUnbindArgs } from "./port_bind_args.ts";

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
