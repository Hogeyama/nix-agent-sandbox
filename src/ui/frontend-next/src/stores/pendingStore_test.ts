import { describe, expect, test } from "bun:test";
import {
  createPendingStore,
  normalizeHostExecPending,
  normalizeNetworkPending,
} from "./pendingStore";
import type { HostExecPendingItemLike, NetworkPendingItemLike } from "./types";

function makeNetwork(
  overrides: Partial<NetworkPendingItemLike> = {},
): NetworkPendingItemLike {
  return {
    id: "req-1",
    sessionId: "s_abcdef0123456789",
    sessionName: "session-a",
    createdAt: "2026-04-26T03:00:00.000Z",
    method: "GET",
    host: "api.github.com",
    port: 443,
    ...overrides,
  };
}

function makeHostExec(
  overrides: Partial<HostExecPendingItemLike> = {},
): HostExecPendingItemLike {
  return {
    id: "exec-1",
    sessionId: "s_abcdef0123456789",
    sessionName: "session-a",
    createdAt: "2026-04-26T03:00:00.000Z",
    argv: ["git", "push"],
    ...overrides,
  };
}

describe("normalizeNetworkPending", () => {
  test("formats verb and host:port summary", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({
        method: "GET",
        host: "api.github.com",
        port: 443,
      }),
    ]);
    expect(rows[0]?.verb).toBe("GET");
    expect(rows[0]?.summary).toBe("api.github.com:443");
  });

  test("verb defaults to GET when method is missing", () => {
    const rows = normalizeNetworkPending([makeNetwork({ method: undefined })]);
    expect(rows[0]?.verb).toBe("GET");
    const rows2 = normalizeNetworkPending([makeNetwork({ method: null })]);
    expect(rows2[0]?.verb).toBe("GET");
  });

  test("verb is uppercased", () => {
    const rows = normalizeNetworkPending([makeNetwork({ method: "post" })]);
    expect(rows[0]?.verb).toBe("POST");
  });

  test("createdAtMs is a finite number for valid ISO", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ createdAt: "2026-04-26T03:00:00.000Z" }),
    ]);
    expect(rows[0]?.createdAtMs).not.toBeNull();
    expect(Number.isFinite(rows[0]?.createdAtMs ?? Number.NaN)).toBe(true);
  });

  test("createdAtMs is null when ISO is unparseable", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ createdAt: "not-a-date" }),
    ]);
    expect(rows[0]?.createdAtMs).toBeNull();
  });

  test("empty input yields empty output", () => {
    expect(normalizeNetworkPending([])).toEqual([]);
  });

  test("sessionShortId truncates after s_ to 6 chars", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ sessionId: "s_7a3f1234567890" }),
    ]);
    expect(rows[0]?.sessionShortId).toBe("s_7a3f12");
  });

  test("sessionName falls back to null when missing", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ sessionName: undefined }),
    ]);
    expect(rows[0]?.sessionName).toBeNull();
  });
});

describe("normalizeHostExecPending", () => {
  test("argv joins with single space", () => {
    const rows = normalizeHostExecPending([
      makeHostExec({ argv: ["git", "push"] }),
    ]);
    expect(rows[0]?.command).toBe("git push");
  });

  test("empty argv produces empty command without throwing", () => {
    const rows = normalizeHostExecPending([makeHostExec({ argv: [] })]);
    expect(rows[0]?.command).toBe("");
  });

  test("createdAtMs is null when ISO is unparseable", () => {
    const rows = normalizeHostExecPending([
      makeHostExec({ createdAt: "garbage" }),
    ]);
    expect(rows[0]?.createdAtMs).toBeNull();
  });

  test("empty input yields empty output", () => {
    expect(normalizeHostExecPending([])).toEqual([]);
  });
});

describe("createPendingStore", () => {
  test("network() and hostexec() reflect setters", () => {
    const store = createPendingStore();
    expect(store.network()).toEqual([]);
    expect(store.hostexec()).toEqual([]);

    store.setNetwork([makeNetwork()]);
    store.setHostExec([makeHostExec()]);

    expect(store.network()).toHaveLength(1);
    expect(store.hostexec()).toHaveLength(1);
    expect(store.network()[0]?.summary).toBe("api.github.com:443");
    expect(store.hostexec()[0]?.command).toBe("git push");
  });

  test("setters replace previous rows", () => {
    const store = createPendingStore();
    store.setNetwork([makeNetwork({ id: "a" })]);
    store.setNetwork([makeNetwork({ id: "b" })]);
    expect(store.network()).toHaveLength(1);
    expect(store.network()[0]?.id).toBe("b");
  });
});
