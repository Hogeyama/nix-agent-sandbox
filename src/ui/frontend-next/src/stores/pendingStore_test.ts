import { describe, expect, test } from "bun:test";
import { pendingRequestKey } from "./pendingRequestKey";
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
    requestId: "req-1",
    sessionId: "s_abcdef0123456789",
    createdAt: "2026-04-26T03:00:00.000Z",
    method: "GET",
    target: { host: "api.github.com", port: 443 },
    ...overrides,
  };
}

function makeHostExec(
  overrides: Partial<HostExecPendingItemLike> = {},
): HostExecPendingItemLike {
  return {
    requestId: "exec-1",
    sessionId: "s_abcdef0123456789",
    createdAt: "2026-04-26T03:00:00.000Z",
    argv0: "git",
    args: ["push"],
    ...overrides,
  };
}

describe("normalizeNetworkPending", () => {
  test("formats verb and host:port summary", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({
        method: "GET",
        target: { host: "api.github.com", port: 443 },
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

  test("sessionName is always null because the SSE payload omits it", () => {
    const rows = normalizeNetworkPending([makeNetwork()]);
    expect(rows[0]?.sessionName).toBeNull();
  });

  test("key is the network composite of sessionId and requestId", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ sessionId: "s_abc", requestId: "req-1" }),
    ]);
    expect(rows[0]?.key).toBe(pendingRequestKey("network", "s_abc", "req-1"));
  });

  test("id alias of requestId is preserved alongside key", () => {
    // Regression guard: a future refactor must not silently drop the
    // `id` field. Per-card state lookup migrates to `key`, but `id`
    // stays available for any consumer that already reads it.
    const rows = normalizeNetworkPending([
      makeNetwork({ requestId: "req-zzz" }),
    ]);
    expect(rows[0]?.id).toBe("req-zzz");
  });
});

describe("normalizeHostExecPending", () => {
  test("argv0 + args join with single space", () => {
    const rows = normalizeHostExecPending([
      makeHostExec({ argv0: "git", args: ["push"] }),
    ]);
    expect(rows[0]?.command).toBe("git push");
  });

  test("empty args yields just argv0 in the command", () => {
    const rows = normalizeHostExecPending([
      makeHostExec({ argv0: "ls", args: [] }),
    ]);
    expect(rows[0]?.command).toBe("ls");
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

  test("key is the hostexec composite of sessionId and requestId", () => {
    const rows = normalizeHostExecPending([
      makeHostExec({ sessionId: "s_abc", requestId: "exec-1" }),
    ]);
    expect(rows[0]?.key).toBe(pendingRequestKey("hostexec", "s_abc", "exec-1"));
  });

  test("hostexec key is distinct from network key with the same sessionId and requestId", () => {
    const net = normalizeNetworkPending([
      makeNetwork({ sessionId: "s_abc", requestId: "shared" }),
    ]);
    const exec = normalizeHostExecPending([
      makeHostExec({ sessionId: "s_abc", requestId: "shared" }),
    ]);
    expect(net[0]?.key).not.toBe(exec[0]?.key);
  });

  test("id alias of requestId is preserved alongside key", () => {
    const rows = normalizeHostExecPending([
      makeHostExec({ requestId: "exec-zzz" }),
    ]);
    expect(rows[0]?.id).toBe("exec-zzz");
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
    store.setNetwork([makeNetwork({ requestId: "a" })]);
    store.setNetwork([makeNetwork({ requestId: "b" })]);
    expect(store.network()).toHaveLength(1);
    expect(store.network()[0]?.id).toBe("b");
  });
});
