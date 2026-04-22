import { expect, test } from "bun:test";
import type { DtachSession } from "./api.ts";
import {
  initialTerminalUiState,
  type TerminalUiState,
  terminalUiReducer,
} from "./terminalUiState.ts";

function makeDtachSession(
  sessionId: string,
  overrides: Partial<DtachSession> = {},
): DtachSession {
  return {
    name: sessionId,
    sessionId,
    socketPath: `/tmp/${sessionId}.sock`,
    createdAt: 1,
    ...overrides,
  };
}

function withDtach(sessions: DtachSession[]): TerminalUiState {
  return { ...initialTerminalUiState, dtachSessions: sessions };
}

test("attach: adds open id, sets active, and shows the modal", () => {
  const next = terminalUiReducer(withDtach([makeDtachSession("sess-1")]), {
    type: "attach",
    sessionId: "sess-1",
  });
  expect(next.openSessionIds).toEqual(["sess-1"]);
  expect(next.activeSessionId).toBe("sess-1");
  expect(next.visible).toBe(true);
});

test("attach: idempotent on already-open id (no duplicate)", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1")],
    openSessionIds: ["sess-1"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "attach",
    sessionId: "sess-1",
  });
  expect(next.openSessionIds).toEqual(["sess-1"]);
  // Same shape -> stable reference (bonus memo win)
  expect(next).toBe(start);
});

test("shell-started: optimistically inserts dtach + open + active + visible", () => {
  const next = terminalUiReducer(initialTerminalUiState, {
    type: "shell-started",
    sessionId: "shell-sess-1.1",
    createdAt: 1234,
  });
  expect(next.dtachSessions).toEqual([
    {
      name: "shell-sess-1.1",
      sessionId: "shell-sess-1.1",
      socketPath: "",
      createdAt: 1234,
    },
  ]);
  expect(next.openSessionIds).toEqual(["shell-sess-1.1"]);
  expect(next.activeSessionId).toBe("shell-sess-1.1");
  expect(next.visible).toBe(true);
});

test("shell-started: idempotent across both dtachSessions and openSessionIds", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("shell-sess-1.1")],
    openSessionIds: ["shell-sess-1.1"],
    activeSessionId: "shell-sess-1.1",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "shell-started",
    sessionId: "shell-sess-1.1",
    createdAt: 9999,
  });
  expect(next.dtachSessions).toBe(start.dtachSessions);
  expect(next.openSessionIds).toBe(start.openSessionIds);
  expect(next.dtachSessions).toHaveLength(1);
  expect(next.openSessionIds).toEqual(["shell-sess-1.1"]);
});

test("shell-started followed by SSE catch-up does not duplicate the session", () => {
  // Optimistic + SSE catch-up race: after the optimistic insert, the SSE
  // `terminal:sessions` event arrives carrying the canonical session
  // record. The reducer must replace (not append) the entry so neither
  // dtachSessions nor openSessionIds gain a duplicate.
  const afterShell = terminalUiReducer(initialTerminalUiState, {
    type: "shell-started",
    sessionId: "shell-sess-1.1",
    createdAt: 1000,
  });
  const canonical = makeDtachSession("shell-sess-1.1", {
    socketPath: "/run/dtach/shell-sess-1.1.sock",
    createdAt: 1500,
  });
  const next = terminalUiReducer(afterShell, {
    type: "set-dtach-sessions",
    sessions: [canonical],
  });
  expect(next.dtachSessions).toEqual([canonical]);
  expect(next.openSessionIds).toEqual(["shell-sess-1.1"]);
  expect(next.activeSessionId).toBe("shell-sess-1.1");
  expect(next.visible).toBe(true);
});

test("select-tab: switches active and adds id to open (re-attach path)", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1"), makeDtachSession("sess-2")],
    openSessionIds: ["sess-1"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "select-tab",
    sessionId: "sess-2",
  });
  expect(next.openSessionIds).toEqual(["sess-1", "sess-2"]);
  expect(next.activeSessionId).toBe("sess-2");
  expect(next.visible).toBe(true);
});

test("close-tab: closing the active tab promotes next[0] as active", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1"), makeDtachSession("sess-2")],
    openSessionIds: ["sess-1", "sess-2"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "close-tab",
    sessionId: "sess-1",
  });
  expect(next.openSessionIds).toEqual(["sess-2"]);
  expect(next.activeSessionId).toBe("sess-2");
  expect(next.visible).toBe(true);
});

test("close-tab: closing the last tab hides the modal", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1")],
    openSessionIds: ["sess-1"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "close-tab",
    sessionId: "sess-1",
  });
  expect(next.openSessionIds).toEqual([]);
  expect(next.activeSessionId).toBeNull();
  expect(next.visible).toBe(false);
});

test("close-tab: closing a non-active tab keeps the current active unchanged", () => {
  const start: TerminalUiState = {
    dtachSessions: [
      makeDtachSession("sess-1"),
      makeDtachSession("sess-2"),
      makeDtachSession("sess-3"),
    ],
    openSessionIds: ["sess-1", "sess-2", "sess-3"],
    activeSessionId: "sess-2",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "close-tab",
    sessionId: "sess-3",
  });
  expect(next.openSessionIds).toEqual(["sess-1", "sess-2"]);
  expect(next.activeSessionId).toBe("sess-2");
  expect(next.visible).toBe(true);
});

test("minimize: hides the modal but keeps open tabs", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1")],
    openSessionIds: ["sess-1"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, { type: "minimize" });
  expect(next.visible).toBe(false);
  expect(next.openSessionIds).toEqual(["sess-1"]);
  expect(next.activeSessionId).toBe("sess-1");
});

test("minimize: returns the same state reference when already hidden", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1")],
    openSessionIds: ["sess-1"],
    activeSessionId: "sess-1",
    visible: false,
  };
  const next = terminalUiReducer(start, { type: "minimize" });
  expect(next).toBe(start);
});

test("restore: returns the same state reference when already visible with active set", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1"), makeDtachSession("sess-2")],
    openSessionIds: ["sess-1", "sess-2"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, { type: "restore" });
  expect(next).toBe(start);
});

test("restore: when active is null, falls back to openSessionIds[0]", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1"), makeDtachSession("sess-2")],
    openSessionIds: ["sess-1", "sess-2"],
    activeSessionId: null,
    visible: false,
  };
  const next = terminalUiReducer(start, { type: "restore" });
  expect(next.activeSessionId).toBe("sess-1");
  expect(next.visible).toBe(true);
});

test("set-dtach-sessions: prunes vanished open ids and reassigns active", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1"), makeDtachSession("sess-2")],
    openSessionIds: ["sess-1", "sess-2"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "set-dtach-sessions",
    sessions: [makeDtachSession("sess-2")],
  });
  expect(next.openSessionIds).toEqual(["sess-2"]);
  expect(next.activeSessionId).toBe("sess-2");
  expect(next.visible).toBe(true);
});

test("set-dtach-sessions: clearing all sessions hides the modal and clears state", () => {
  const start: TerminalUiState = {
    dtachSessions: [makeDtachSession("sess-1")],
    openSessionIds: ["sess-1"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "set-dtach-sessions",
    sessions: [],
  });
  expect(next.dtachSessions).toEqual([]);
  expect(next.openSessionIds).toEqual([]);
  expect(next.activeSessionId).toBeNull();
  expect(next.visible).toBe(false);
});

test("set-dtach-sessions: returns the same state reference when nothing changed", () => {
  // Pins the reference-equality optimization: without this, child
  // components like TerminalModal would lose their memoization win.
  const sessions = [makeDtachSession("sess-1"), makeDtachSession("sess-2")];
  const start: TerminalUiState = {
    dtachSessions: sessions,
    openSessionIds: ["sess-1"],
    activeSessionId: "sess-1",
    visible: true,
  };
  const next = terminalUiReducer(start, {
    type: "set-dtach-sessions",
    // Same content, fresh array reference (mirrors a fresh SSE payload).
    sessions: [makeDtachSession("sess-1"), makeDtachSession("sess-2")],
  });
  expect(next).toBe(start);
});
