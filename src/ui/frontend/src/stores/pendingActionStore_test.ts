/**
 * Tests for the Solid surface of `pendingActionStore`.
 *
 * The reduction semantics are pinned in
 * `reconcilePendingActionState_test.ts`; this file only verifies that
 * the store delegates to the reducer and exposes accessors that reflect
 * the underlying signal.
 */

import { describe, expect, test } from "bun:test";
import { createPendingActionStore } from "./pendingActionStore";
import { pendingRequestKey } from "./pendingRequestKey";

const NET_A = pendingRequestKey("network", "sA", "rA");
const NET_B = pendingRequestKey("network", "sB", "rB");
const EXEC_A = pendingRequestKey("hostexec", "sA", "rA");

describe("pendingActionStore", () => {
  test("scopeFor / busyFor / errorFor return the current state", () => {
    const store = createPendingActionStore();
    expect(store.scopeFor(NET_A)).toBeUndefined();
    expect(store.busyFor(NET_A)).toBe(false);
    expect(store.errorFor(NET_A)).toBeNull();

    store.setScope(NET_A, "host-port");
    expect(store.scopeFor(NET_A)).toBe("host-port");

    store.beginAction(NET_A);
    expect(store.busyFor(NET_A)).toBe(true);

    store.endAction(NET_A, "denied");
    expect(store.busyFor(NET_A)).toBe(false);
    expect(store.errorFor(NET_A)).toBe("denied");
  });

  test("endAction with no message clears busy and error", () => {
    const store = createPendingActionStore();
    store.beginAction(NET_A);
    store.endAction(NET_A, "boom");
    store.beginAction(NET_A);
    store.endAction(NET_A);
    expect(store.busyFor(NET_A)).toBe(false);
    expect(store.errorFor(NET_A)).toBeNull();
  });

  test("reconcile drops keys missing from snapshot for the given domain", () => {
    const store = createPendingActionStore();
    store.setScope(NET_A, "host-port");
    store.setScope(NET_B, "host");
    store.setScope(EXEC_A, "capability");

    store.reconcile("network", [NET_A]);

    // NET_B (network) dropped; NET_A preserved; EXEC_A untouched because
    // the reconcile targeted only the network domain.
    expect(store.scopeFor(NET_A)).toBe("host-port");
    expect(store.scopeFor(NET_B)).toBeUndefined();
    expect(store.scopeFor(EXEC_A)).toBe("capability");
  });

  test("reconcile clears busy and error for a removed key", () => {
    const store = createPendingActionStore();
    store.beginAction(NET_A);
    store.endAction(NET_A, "denied");
    store.reconcile("network", []);
    expect(store.busyFor(NET_A)).toBe(false);
    expect(store.errorFor(NET_A)).toBeNull();
  });
});
