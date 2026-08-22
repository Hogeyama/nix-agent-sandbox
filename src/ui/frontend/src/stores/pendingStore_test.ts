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
    sessionId: "sess_abcdef012345",
    createdAt: "2026-04-26T03:00:00.000Z",
    method: "GET",
    target: { host: "api.github.com", port: 443 },
    ...overrides,
  };
}

function makeHostExec(
  overrides: Partial<
    HostExecPendingItemLike & { integrityChanged: boolean }
  > = {},
): HostExecPendingItemLike {
  return {
    requestId: "exec-1",
    sessionId: "sess_abcdef012345",
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

  test("carries the rule the confirmation came from and the offered scopes", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({
        ruleId: "github.gql.write",
        approvalScopes: ["once", "rule"],
      }),
    ]);
    expect(rows[0]?.ruleId).toBe("github.gql.write");
    expect(rows[0]?.approvalScopes).toEqual(["once", "rule"]);
  });

  test("carries why the confirmation is being asked", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({
        ruleId: "anthropic.$fallback",
        askReason: "scope-fallback",
      }),
    ]);
    expect(rows[0]?.askReason).toBe("scope-fallback");
  });

  test("no reason when the payload omits it", () => {
    // 違反から生じた確認は理由を持たない。並んでいる違反が理由そのもので、
    // 判定の理由ではない。
    const rows = normalizeNetworkPending([
      makeNetwork({ askReason: undefined }),
    ]);
    expect(rows[0]?.askReason).toBeNull();
  });

  test("carries the selected indeterminate body diagnostic", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({
        askReason: "indeterminate",
        bodyDiagnostic: {
          code: "body-too-large",
          byteLength: 9_000_000,
          maxBodyBytes: 8_388_608,
        },
      }),
    ]);
    expect(rows[0]?.bodyDiagnostic).toEqual({
      code: "body-too-large",
      byteLength: 9_000_000,
      maxBodyBytes: 8_388_608,
    });
  });

  test("normalizes an omitted body diagnostic to null", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ bodyDiagnostic: undefined }),
    ]);
    expect(rows[0]?.bodyDiagnostic).toBeNull();
  });

  test("an entry that offers no scopes falls back to the narrowest one", () => {
    // A payload without the field can only be trusted for this one
    // request; guessing a wider grain would remember an approval the
    // backend never advertised.
    const rows = normalizeNetworkPending([
      makeNetwork({ approvalScopes: undefined }),
    ]);
    expect(rows[0]?.approvalScopes).toEqual(["once"]);
    const empty = normalizeNetworkPending([
      makeNetwork({ approvalScopes: [] }),
    ]);
    expect(empty[0]?.approvalScopes).toEqual(["once"]);
  });

  test("carries the headers an approval would inject, by name", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({
        injectHeaders: [
          { name: "Authorization", secrets: ["gh-token"] },
          { name: "X-Plain", secrets: null },
        ],
      }),
    ]);
    expect(rows[0]?.injectHeaders).toEqual([
      { name: "Authorization", secrets: ["gh-token"] },
      { name: "X-Plain", secrets: [] },
    ]);
  });

  test("no inject headers when the payload omits them", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ injectHeaders: undefined }),
    ]);
    expect(rows[0]?.injectHeaders).toEqual([]);
  });

  test("carries the violations an approval would remember", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({
        approvalScopes: ["once", "violation"],
        violations: [
          {
            at: "/**/content/*",
            kind: "schema-mismatch",
            pointer: "/messages/0/content/1",
            value: "future_block",
            excerpt: '{"type":"future_block"}',
            count: 3,
          },
        ],
      }),
    ]);
    expect(rows[0]?.approvalScopes).toEqual(["once", "violation"]);
    expect(rows[0]?.violations).toEqual([
      {
        at: "/**/content/*",
        kind: "schema-mismatch",
        pointer: "/messages/0/content/1",
        value: "future_block",
        excerpt: '{"type":"future_block"}',
        count: 3,
      },
    ]);
  });

  test("a violation with no value is still one violation", () => {
    // 「ボディが空であること」のような受理条件には承認すべき値が無い。
    // 値が無いことは記録が無いことではない。
    const rows = normalizeNetworkPending([
      makeNetwork({ violations: [{ kind: "unexpected-body" }] }),
    ]);
    expect(rows[0]?.violations).toEqual([
      {
        at: "",
        kind: "unexpected-body",
        pointer: "",
        value: null,
        excerpt: null,
        count: 1,
      },
    ]);
  });

  test("no violations when the payload omits them", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ violations: undefined }),
    ]);
    expect(rows[0]?.violations).toEqual([]);
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

  test("sessionShortId strips the sess_ prefix and returns the next 6 chars", () => {
    const rows = normalizeNetworkPending([
      makeNetwork({ sessionId: "sess_7a3f12345abc" }),
    ]);
    expect(rows[0]?.sessionShortId).toBe("7a3f12");
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

  test("normalizeHostExecPending: carries integrityChanged flag", () => {
    const rows = normalizeHostExecPending([
      makeHostExec({ argv0: "tool.sh", args: [], integrityChanged: true }),
    ]);
    expect(rows[0].integrityChanged).toBe(true);
  });

  test("normalizeHostExecPending: defaults integrityChanged to false", () => {
    const rows = normalizeHostExecPending([
      makeHostExec({ argv0: "tool.sh", args: [] }),
    ]);
    expect(rows[0].integrityChanged).toBe(false);
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
