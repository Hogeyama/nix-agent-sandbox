import { describe, expect, test } from "bun:test";
import {
  createSessionsStore,
  normalizeContainersToSessions,
} from "./sessionsStore";
import type { ContainerInfoLike } from "./types";

function makeContainer(
  overrides: Partial<ContainerInfoLike> = {},
): ContainerInfoLike {
  return {
    name: "default-name",
    running: true,
    labels: { "nas.kind": "agent" },
    sessionId: "sess_abcdef012345",
    sessionName: "default-session",
    ...overrides,
  };
}

describe("normalizeContainersToSessions", () => {
  test("excludes non-agent sidecar containers (e.g. dind)", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({
        name: "sidecar-dind",
        labels: { "nas.kind": "dind" },
      }),
      makeContainer({ name: "agent-1" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("default-session");
  });

  test("excludes agent containers without sessionId (transient state)", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({ sessionId: null }),
      makeContainer({ sessionId: undefined }),
    ]);
    expect(rows).toHaveLength(0);
  });

  test("dir is null when labels['nas.pwd'] is undefined", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({ labels: { "nas.kind": "agent" } }),
    ]);
    expect(rows[0]?.dir).toBeNull();
  });

  test("worktreeName and baseBranch are null when worktree is null", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({ worktree: null }),
    ]);
    expect(rows[0]?.worktreeName).toBeNull();
    expect(rows[0]?.baseBranch).toBeNull();
  });

  test("worktree fields populate from worktree object", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({
        worktree: { name: "feature-x", baseBranch: "main" },
      }),
    ]);
    expect(rows[0]?.worktreeName).toBe("feature-x");
    expect(rows[0]?.baseBranch).toBe("main");
  });

  test("shortId strips the sess_ prefix and returns the next 6 chars", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({ sessionId: "sess_7a3f12345abc" }),
    ]);
    expect(rows[0]?.shortId).toBe("7a3f12");
  });

  test("turn is null when undefined on the payload", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({ turn: undefined }),
    ]);
    expect(rows[0]?.turn).toBeNull();
  });

  test("name falls back to container name when sessionName is missing", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({ name: "container-name", sessionName: null }),
    ]);
    expect(rows[0]?.name).toBe("container-name");
  });

  test("dir reads labels['nas.pwd'] when present", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({
        labels: { "nas.kind": "agent", "nas.pwd": "/home/user/repo" },
      }),
    ]);
    expect(rows[0]?.dir).toBe("/home/user/repo");
  });

  test("containerName equals container.name even when sessionName is missing", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({ name: "agent-xyz", sessionName: null }),
    ]);
    // `name` falls back to container.name for display, but `containerName`
    // always mirrors the Docker container name verbatim.
    expect(rows[0]?.name).toBe("agent-xyz");
    expect(rows[0]?.containerName).toBe("agent-xyz");
  });

  test("containerName is independent of sessionName when both are set", () => {
    const rows = normalizeContainersToSessions([
      makeContainer({ name: "agent-xyz", sessionName: "human-readable" }),
    ]);
    expect(rows[0]?.name).toBe("human-readable");
    expect(rows[0]?.containerName).toBe("agent-xyz");
  });

  test("lastEventAt is null when payload omits it, copies the ISO string when present", () => {
    const rowsWithout = normalizeContainersToSessions([
      makeContainer({ lastEventAt: undefined }),
    ]);
    expect(rowsWithout[0]?.lastEventAt).toBeNull();

    const rowsWith = normalizeContainersToSessions([
      makeContainer({ lastEventAt: "2026-04-26T10:20:30.000Z" }),
    ]);
    expect(rowsWith[0]?.lastEventAt).toBe("2026-04-26T10:20:30.000Z");
  });
});

describe("createSessionsStore", () => {
  test("rows() reflects setSessions input", () => {
    const store = createSessionsStore();
    expect(store.rows()).toEqual([]);
    store.setSessions([
      {
        name: "agent-a",
        running: true,
        labels: { "nas.kind": "agent" },
        sessionId: "sess_aaaaaa111111",
        sessionName: "session-a",
      },
    ]);
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]?.id).toBe("sess_aaaaaa111111");
    expect(store.rows()[0]?.shortId).toBe("aaaaaa");
  });

  test("setSessions replaces previous rows", () => {
    const store = createSessionsStore();
    store.setSessions([
      {
        name: "first",
        running: true,
        labels: { "nas.kind": "agent" },
        sessionId: "sess_111111111111",
      },
    ]);
    store.setSessions([
      {
        name: "second",
        running: true,
        labels: { "nas.kind": "agent" },
        sessionId: "sess_222222222222",
      },
    ]);
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]?.id).toBe("sess_222222222222");
  });
});
