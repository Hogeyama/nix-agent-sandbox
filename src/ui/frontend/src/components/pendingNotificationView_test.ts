import { describe, expect, test } from "bun:test";
import {
  filterPendingForSession,
  groupPendingNotifications,
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
