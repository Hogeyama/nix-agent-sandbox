import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  extractSessionId,
  handleTerminalMessage,
  parseTerminalControlMessage,
  type TerminalWSData,
} from "./terminal.ts";

function makeWs(writes: Buffer[]): ServerWebSocket<TerminalWSData> {
  return {
    data: {
      sessionId: "sess-1",
      socket: {
        destroyed: false,
        write: (chunk: Buffer) => {
          writes.push(chunk);
          return true;
        },
      },
      pendingMessages: [],
      initialRedrawSent: false,
    },
  } as unknown as ServerWebSocket<TerminalWSData>;
}

test("parseTerminalControlMessage: resize with positive integer dims is accepted", () => {
  expect(
    parseTerminalControlMessage(
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
    ),
  ).toEqual({
    kind: "resize",
    cols: 120,
    rows: 40,
  });
});

test("parseTerminalControlMessage: resize with null dims is invalid control", () => {
  expect(
    parseTerminalControlMessage(
      JSON.stringify({ type: "resize", cols: null, rows: null }),
    ),
  ).toBe("invalid-control");
});

test("handleTerminalMessage: invalid resize control is ignored", () => {
  const writes: Buffer[] = [];
  const ws = makeWs(writes);

  handleTerminalMessage(
    ws,
    JSON.stringify({ type: "resize", cols: null, rows: null }),
  );

  expect(writes).toHaveLength(0);
  expect(ws.data.initialRedrawSent).toBe(false);
});

test("handleTerminalMessage: plain text is still forwarded to dtach", () => {
  const writes: Buffer[] = [];
  const ws = makeWs(writes);

  handleTerminalMessage(ws, "echo hi\n");

  expect(writes).toHaveLength(1);
  expect([...writes[0]]).toEqual([0, 8, 101, 99, 104, 111, 32, 104, 105, 10]);
});

test("extractSessionId: returns the plain id for a legit sess_<hex>", () => {
  expect(extractSessionId("/api/terminal/sess_abc123")).toBe("sess_abc123");
});

test("extractSessionId: returns the plain id for a shell-<parent>.<seq>", () => {
  expect(extractSessionId("/api/terminal/shell-sess_abc.1")).toBe(
    "shell-sess_abc.1",
  );
});

test("extractSessionId: rejects URL-encoded path traversal", () => {
  expect(extractSessionId("/api/terminal/..%2F..%2Fetc%2Fpasswd")).toBeNull();
});

test("extractSessionId: rejects a decoded `..` substring", () => {
  expect(extractSessionId("/api/terminal/foo..bar")).toBeNull();
});

test("extractSessionId: rejects unknown path shape", () => {
  expect(extractSessionId("/api/not-terminal/sess_abc123")).toBeNull();
});

test("extractSessionId: rejects empty segment", () => {
  expect(extractSessionId("/api/terminal/")).toBeNull();
});

test("extractSessionId: rejects malformed percent encoding", () => {
  // decodeURIComponent throws on a lone %, triggering the catch.
  expect(extractSessionId("/api/terminal/bad%zz")).toBeNull();
});
