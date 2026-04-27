/**
 * Tests for `getTerminalSize` / `sendTerminalResize`.
 *
 * Both functions are pure and accept structural minimums (a fit-addon
 * shape and a `Pick<WebSocket, ...>` shape) so the suite uses fakes
 * rather than booting xterm or opening a real socket. The boundaries
 * pinned here are exactly the ones the wider terminal pipeline relies
 * on: degenerate dims must collapse to `null`, and resize frames must
 * never go out on a non-OPEN socket.
 */

import { expect, test } from "bun:test";
import { getTerminalSize, sendTerminalResize } from "./terminalSize";

test("getTerminalSize returns positive cols/rows as-is", () => {
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 80, rows: 24 }) }),
  ).toEqual({ cols: 80, rows: 24 });
});

test("getTerminalSize returns null when proposeDimensions returns undefined", () => {
  expect(getTerminalSize({ proposeDimensions: () => undefined })).toBeNull();
});

test("getTerminalSize returns null for cols=0 / rows=0", () => {
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 0, rows: 24 }) }),
  ).toBeNull();
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 80, rows: 0 }) }),
  ).toBeNull();
});

test("getTerminalSize returns null for negative cols/rows", () => {
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: -1, rows: 24 }) }),
  ).toBeNull();
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 80, rows: -3 }) }),
  ).toBeNull();
});

test("getTerminalSize returns null for non-integer (float) dims", () => {
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 80.5, rows: 24 }) }),
  ).toBeNull();
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 80, rows: 24.1 }) }),
  ).toBeNull();
});

test("getTerminalSize returns null for null/undefined fitAddon", () => {
  expect(getTerminalSize(null)).toBeNull();
  expect(getTerminalSize(undefined)).toBeNull();
});

test("sendTerminalResize sends a resize frame with shape {type,cols,rows}", () => {
  const calls: string[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      calls.push(data);
    },
  };
  sendTerminalResize(fakeWs, { cols: 80, rows: 24 });
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0] as string)).toEqual({
    type: "resize",
    cols: 80,
    rows: 24,
  });
});

test("sendTerminalResize is a no-op when ws is not OPEN", () => {
  const calls: string[] = [];
  const fakeWs = {
    readyState: WebSocket.CONNECTING,
    send: (data: string) => {
      calls.push(data);
    },
  };
  sendTerminalResize(fakeWs, { cols: 80, rows: 24 });
  expect(calls).toHaveLength(0);
  sendTerminalResize(null, { cols: 80, rows: 24 });
  sendTerminalResize(undefined, { cols: 80, rows: 24 });
  expect(calls).toHaveLength(0);
});
