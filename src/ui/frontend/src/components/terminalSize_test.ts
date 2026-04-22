import { expect, test } from "bun:test";
import { getTerminalSize, sendTerminalResize } from "./terminalSize.ts";

test("getTerminalSize returns positive cols/rows as-is", () => {
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 80, rows: 24 }) }),
  ).toEqual({ cols: 80, rows: 24 });
});

test("getTerminalSize returns null when proposeDimensions returns null", () => {
  expect(getTerminalSize({ proposeDimensions: () => undefined })).toBeNull();
});

test("getTerminalSize returns null for zero/negative cols", () => {
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 0, rows: 24 }) }),
  ).toBeNull();
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: -5, rows: 24 }) }),
  ).toBeNull();
});

test("getTerminalSize returns null for non-integer cols", () => {
  expect(
    getTerminalSize({ proposeDimensions: () => ({ cols: 80.5, rows: 24 }) }),
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

test("sendTerminalResize does nothing when ws not open", () => {
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
