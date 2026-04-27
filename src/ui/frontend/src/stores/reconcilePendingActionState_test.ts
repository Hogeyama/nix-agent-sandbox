/**
 * Canonical contract tests for the pending-action reducer.
 *
 * The reducer is the source of truth for the SSE drop / preserve /
 * cross-domain rules. The Solid store delegates to it; the surface
 * tests in `pendingActionStore_test.ts` cover the accessor wiring but
 * not the reduction semantics.
 */

import { describe, expect, test } from "bun:test";
import { pendingRequestKey } from "./pendingRequestKey";
import {
  beginAction,
  emptyPendingActionState,
  endAction,
  reconcilePendingActionState,
  setScope,
} from "./reconcilePendingActionState";

const NET_A = pendingRequestKey("network", "sA", "rA");
const NET_B = pendingRequestKey("network", "sB", "rB");
const EXEC_A = pendingRequestKey("hostexec", "sA", "rA");
const EXEC_B = pendingRequestKey("hostexec", "sB", "rB");

describe("setScope", () => {
  test("records the scope for the given key without touching other keys", () => {
    const s0 = emptyPendingActionState();
    const s1 = setScope(s0, NET_A, "host-port");
    const s2 = setScope(s1, NET_B, "host");
    expect(s2.scopeByKey[NET_A]).toBe("host-port");
    expect(s2.scopeByKey[NET_B]).toBe("host");
  });

  test("changing scope on (network, sA, rA) does not affect (hostexec, sA, rA)", () => {
    // Key isolation across domains: the same `requestId` lives in two
    // separate domains and the composite `key` keeps their state
    // independent even when the underlying broker ids collide.
    const s0 = setScope(emptyPendingActionState(), NET_A, "once");
    const s1 = setScope(s0, EXEC_A, "capability");
    const s2 = setScope(s1, NET_A, "host");
    expect(s2.scopeByKey[NET_A]).toBe("host");
    expect(s2.scopeByKey[EXEC_A]).toBe("capability");
  });
});

describe("beginAction / endAction", () => {
  test("beginAction sets busy=true and clears any prior error", () => {
    const s0 = endAction(emptyPendingActionState(), NET_A, "boom");
    expect(s0.errorByKey[NET_A]).toBe("boom");
    const s1 = beginAction(s0, NET_A);
    expect(s1.busyByKey[NET_A]).toBe(true);
    expect(s1.errorByKey[NET_A]).toBeUndefined();
  });

  test("endAction with no message clears busy and any previous error", () => {
    const s0 = beginAction(emptyPendingActionState(), NET_A);
    const s1 = endAction(s0, NET_A);
    expect(s1.busyByKey[NET_A]).toBeUndefined();
    expect(s1.errorByKey[NET_A]).toBeUndefined();
  });

  test("endAction with a message clears busy and records the error", () => {
    const s0 = beginAction(emptyPendingActionState(), NET_A);
    const s1 = endAction(s0, NET_A, "denied");
    expect(s1.busyByKey[NET_A]).toBeUndefined();
    expect(s1.errorByKey[NET_A]).toBe("denied");
  });

  test("endAction with a message after a successful retry clears stale error on next beginAction", () => {
    // Round-trip: first call fails (error set), user retries
    // (beginAction clears error and sets busy), second call succeeds
    // (endAction with no message clears busy and leaves no error).
    let s = emptyPendingActionState();
    s = beginAction(s, NET_A);
    s = endAction(s, NET_A, "first failure");
    expect(s.errorByKey[NET_A]).toBe("first failure");
    s = beginAction(s, NET_A);
    expect(s.errorByKey[NET_A]).toBeUndefined();
    s = endAction(s, NET_A);
    expect(s.busyByKey[NET_A]).toBeUndefined();
    expect(s.errorByKey[NET_A]).toBeUndefined();
  });
});

describe("reconcilePendingActionState SSE cleanup", () => {
  test("network reconcile drops scope/busy/error for keys not in the snapshot", () => {
    let s = emptyPendingActionState();
    s = setScope(s, NET_A, "host-port");
    s = beginAction(s, NET_B);
    s = endAction(s, NET_B, "boom");
    // Snapshot retains only NET_A; NET_B should drop from all three maps.
    const next = reconcilePendingActionState(s, "network", [NET_A]);
    expect(next.scopeByKey[NET_A]).toBe("host-port");
    expect(next.scopeByKey[NET_B]).toBeUndefined();
    expect(next.busyByKey[NET_B]).toBeUndefined();
    expect(next.errorByKey[NET_B]).toBeUndefined();
  });

  test("network reconcile preserves keys still present in the snapshot", () => {
    let s = emptyPendingActionState();
    s = setScope(s, NET_A, "host-port");
    s = beginAction(s, NET_A);
    const next = reconcilePendingActionState(s, "network", [NET_A]);
    expect(next.scopeByKey[NET_A]).toBe("host-port");
    expect(next.busyByKey[NET_A]).toBe(true);
  });

  test("network reconcile does not affect hostexec entries", () => {
    let s = emptyPendingActionState();
    s = setScope(s, EXEC_A, "capability");
    s = setScope(s, EXEC_B, "once");
    s = beginAction(s, EXEC_A);
    s = endAction(s, EXEC_B, "denied");
    // Reconciling the network domain with an empty snapshot must not
    // touch any hostexec entries.
    const next = reconcilePendingActionState(s, "network", []);
    expect(next.scopeByKey[EXEC_A]).toBe("capability");
    expect(next.scopeByKey[EXEC_B]).toBe("once");
    expect(next.busyByKey[EXEC_A]).toBe(true);
    expect(next.errorByKey[EXEC_B]).toBe("denied");
  });

  test("hostexec reconcile does not affect network entries", () => {
    let s = emptyPendingActionState();
    s = setScope(s, NET_A, "host");
    s = beginAction(s, NET_B);
    s = endAction(s, NET_B, "boom");
    const next = reconcilePendingActionState(s, "hostexec", []);
    expect(next.scopeByKey[NET_A]).toBe("host");
    expect(next.busyByKey[NET_B]).toBeUndefined(); // already cleared by endAction
    expect(next.errorByKey[NET_B]).toBe("boom");
  });

  test("empty snapshot for a domain drops every entry of that domain", () => {
    let s = emptyPendingActionState();
    s = setScope(s, NET_A, "host-port");
    s = setScope(s, NET_B, "host");
    s = setScope(s, EXEC_A, "capability");
    const next = reconcilePendingActionState(s, "network", []);
    expect(next.scopeByKey[NET_A]).toBeUndefined();
    expect(next.scopeByKey[NET_B]).toBeUndefined();
    expect(next.scopeByKey[EXEC_A]).toBe("capability");
  });

  test("returned state is a fresh object so callers can identity-compare", () => {
    const s0 = setScope(emptyPendingActionState(), NET_A, "host-port");
    const s1 = reconcilePendingActionState(s0, "network", [NET_A]);
    expect(s1).not.toBe(s0);
    expect(s1.scopeByKey).not.toBe(s0.scopeByKey);
  });
});
