import { describe, expect, test } from "bun:test";
import {
  filterPendingForSession,
  groupPendingNotifications,
  selectPendingNotificationRows,
} from "./pendingNotificationView";

describe("groupPendingNotifications", () => {
  test("groups every request by session and keeps the latest summary", () => {
    const groups = groupPendingNotifications(
      [
        {
          sessionId: "session-a",
          sessionShortId: "aaaaaa",
          createdAtMs: 100,
          verb: "GET",
          summary: "example.com:443",
        },
        {
          sessionId: "session-b",
          sessionShortId: "bbbbbb",
          createdAtMs: 300,
          verb: "POST",
          summary: "api.example.com:443",
        },
      ],
      [
        {
          sessionId: "session-a",
          sessionShortId: "aaaaaa",
          createdAtMs: 200,
          command: "bun test",
        },
        {
          sessionId: "session-a",
          sessionShortId: "aaaaaa",
          createdAtMs: 250,
          command: "bun run check",
        },
      ],
    );

    expect(groups).toEqual([
      {
        sessionId: "session-b",
        sessionShortId: "bbbbbb",
        network: 1,
        hostexec: 0,
        latestSummary: "POST api.example.com:443",
        latestAt: 300,
      },
      {
        sessionId: "session-a",
        sessionShortId: "aaaaaa",
        network: 1,
        hostexec: 2,
        latestSummary: "run bun run check",
        latestAt: 250,
      },
    ]);
  });
});

describe("selectPendingNotificationRows", () => {
  const network = [
    {
      sessionId: "session-a",
      sessionShortId: "aaaaaa",
      createdAtMs: 100,
      verb: "GET",
      summary: "a.example:443",
    },
    {
      sessionId: "session-b",
      sessionShortId: "bbbbbb",
      createdAtMs: 200,
      verb: "POST",
      summary: "b.example:443",
    },
  ];
  const hostexec = [
    {
      sessionId: "session-a",
      sessionShortId: "aaaaaa",
      createdAtMs: 300,
      command: "bun test",
    },
    {
      sessionId: "session-c",
      sessionShortId: "cccccc",
      createdAtMs: 400,
      command: "bun run check",
    },
  ];

  test("selects every approval while the pane is collapsed", () => {
    expect(
      selectPendingNotificationRows(network, hostexec, {
        collapsed: true,
        activeSessionId: "session-a",
        showAllSessions: false,
      }),
    ).toEqual({ network, hostexec });
  });

  test("selects only other sessions while the pane shows the active session", () => {
    expect(
      selectPendingNotificationRows(network, hostexec, {
        collapsed: false,
        activeSessionId: "session-a",
        showAllSessions: false,
      }),
    ).toEqual({ network: [network[1]], hostexec: [hostexec[1]] });
  });

  test("selects nothing while the open pane shows All", () => {
    expect(
      selectPendingNotificationRows(network, hostexec, {
        collapsed: false,
        activeSessionId: "session-a",
        showAllSessions: true,
      }),
    ).toEqual({ network: [], hostexec: [] });
  });

  test("selects nothing when the open pane has no active session", () => {
    expect(
      selectPendingNotificationRows(network, hostexec, {
        collapsed: false,
        activeSessionId: null,
        showAllSessions: false,
      }),
    ).toEqual({ network: [], hostexec: [] });
  });
});

describe("filterPendingForSession", () => {
  const rows = [
    { sessionId: "session-a", requestId: "a-1" },
    { sessionId: "session-b", requestId: "b-1" },
    { sessionId: "session-a", requestId: "a-2" },
  ];

  test("shows only the active session by default", () => {
    expect(filterPendingForSession(rows, "session-a", false)).toEqual([
      rows[0],
      rows[2],
    ]);
  });

  test("shows all rows when All is selected or no session is active", () => {
    expect(filterPendingForSession(rows, "session-a", true)).toBe(rows);
    expect(filterPendingForSession(rows, null, false)).toBe(rows);
  });
});
