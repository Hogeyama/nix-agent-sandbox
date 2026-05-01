/**
 * Tests for `createSseDispatch`.
 *
 * Pin the dispatch contract: the four event names consumed by the
 * sessions and pending panes route to the matching store setter,
 * pending events additionally drive `pendingAction.reconcile` with the
 * snapshot's composite keys, malformed envelopes drop the payload
 * silently (per design: store state is not touched), and unknown event
 * names are no-ops.
 */

import { describe, expect, mock, test } from "bun:test";
import type { SidecarRow } from "../components/settings/sidecarRowView";
import type { AuditStore } from "../stores/auditStore";
import type { PendingActionStore } from "../stores/pendingActionStore";
import { pendingRequestKey } from "../stores/pendingRequestKey";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
  PendingStore,
} from "../stores/pendingStore";
import type { SessionsStore } from "../stores/sessionsStore";
import type { SidecarsStore } from "../stores/sidecarsStore";
import type { TerminalsStore } from "../stores/terminalsStore";
import type {
  AuditLogEntryLike,
  ContainerInfoLike,
  DtachSessionLike,
  HostExecPendingItemLike,
  NetworkPendingItemLike,
  SessionRow,
} from "../stores/types";
import { createSseDispatch, SSE_EVENT_NAMES } from "./createSseDispatch";

interface FakeStores {
  sessions: SessionsStore & { setSessions: ReturnType<typeof mock> };
  sidecars: SidecarsStore & { setSidecars: ReturnType<typeof mock> };
  pending: PendingStore & {
    setNetwork: ReturnType<typeof mock>;
    setHostExec: ReturnType<typeof mock>;
  };
  pendingAction: PendingActionStore & {
    reconcile: ReturnType<typeof mock>;
  };
  terminals: TerminalsStore & {
    setDtachSessions: ReturnType<typeof mock>;
  };
  audit: AuditStore & { setEntries: ReturnType<typeof mock> };
}

function makeFakeStores(): FakeStores {
  const sessions: FakeStores["sessions"] = {
    rows: () => [] as SessionRow[],
    setSessions: mock((_items: ContainerInfoLike[]) => {}),
    applyRename: mock((_sessionId: string, _name: string) => {}),
  };
  const sidecars: FakeStores["sidecars"] = {
    rows: () => [] as SidecarRow[],
    setSidecars: mock((_items: ContainerInfoLike[]) => {}),
  };
  const pending: FakeStores["pending"] = {
    network: () => [] as NetworkPendingRow[],
    hostexec: () => [] as HostExecPendingRow[],
    setNetwork: mock((_items: NetworkPendingItemLike[]) => {}),
    setHostExec: mock((_items: HostExecPendingItemLike[]) => {}),
  };
  const pendingAction: FakeStores["pendingAction"] = {
    scopeFor: () => undefined,
    busyFor: () => false,
    errorFor: () => null,
    setScope: () => {},
    beginAction: () => {},
    endAction: () => {},
    reconcile: mock((_domain, _keys) => {}),
  };
  const terminals: FakeStores["terminals"] = {
    dtachSessions: () => [] as DtachSessionLike[],
    activeId: () => null,
    pendingActivateId: () => null,
    setDtachSessions: mock((_items: DtachSessionLike[]) => {}),
    requestActivate: (_id: string) => {},
    setActive: (_id: string | null) => {},
    selectSession: (_id: string) => {},
    setViewFor: () => {},
    getViewFor: () => undefined,
    tryBeginShellSpawn: () => true,
    clearShellSpawnInFlight: () => {},
    isShellSpawnInFlight: () => false,
  };
  const audit: FakeStores["audit"] = {
    entries: () => [],
    setEntries: mock((_items: AuditLogEntryLike[]) => {}),
  };
  return { sessions, sidecars, pending, pendingAction, terminals, audit };
}

describe("createSseDispatch", () => {
  test("'containers' with valid envelope fans out to both sessions.setSessions and sidecars.setSidecars", () => {
    // Pin the fan-out contract: every `containers` snapshot is handed
    // unchanged to both stores. Each store filters by `nas.kind`, so
    // the views are disjoint by construction; the dispatch layer must
    // never make the kind decision on the stores' behalf.
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: ContainerInfoLike[] = [
      { name: "c1", running: true, labels: { "nas.kind": "agent" } },
    ];
    dispatch("containers", { items });

    expect(stores.sessions.setSessions).toHaveBeenCalledTimes(1);
    expect(stores.sessions.setSessions).toHaveBeenCalledWith(items);
    expect(stores.sidecars.setSidecars).toHaveBeenCalledTimes(1);
    expect(stores.sidecars.setSidecars).toHaveBeenCalledWith(items);
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
    expect(stores.pendingAction.reconcile).not.toHaveBeenCalled();
    expect(stores.audit.setEntries).not.toHaveBeenCalled();
  });

  test("'containers' with a sidecar-only payload still calls both setters with the same array", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: ContainerInfoLike[] = [
      { name: "dind-1", running: true, labels: { "nas.kind": "dind" } },
      { name: "proxy-1", running: true, labels: { "nas.kind": "proxy" } },
    ];
    dispatch("containers", { items });

    expect(stores.sessions.setSessions).toHaveBeenCalledTimes(1);
    expect(stores.sessions.setSessions).toHaveBeenCalledWith(items);
    expect(stores.sidecars.setSidecars).toHaveBeenCalledTimes(1);
    expect(stores.sidecars.setSidecars).toHaveBeenCalledWith(items);
  });

  test("'containers' with a mixed payload calls both setters with the full array", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: ContainerInfoLike[] = [
      { name: "agent-1", running: true, labels: { "nas.kind": "agent" } },
      { name: "dind-1", running: true, labels: { "nas.kind": "dind" } },
    ];
    dispatch("containers", { items });

    expect(stores.sessions.setSessions).toHaveBeenCalledTimes(1);
    expect(stores.sessions.setSessions).toHaveBeenCalledWith(items);
    expect(stores.sidecars.setSidecars).toHaveBeenCalledTimes(1);
    expect(stores.sidecars.setSidecars).toHaveBeenCalledWith(items);
  });

  test("'containers' with an empty array still calls both setters so each store can clear", () => {
    // Symmetric to the pending and audit empty-snapshot cases: an
    // empty `containers` snapshot must hit both setters so an emptied
    // view is rendered as empty rather than holding stale rows.
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    dispatch("containers", { items: [] });

    expect(stores.sessions.setSessions).toHaveBeenCalledTimes(1);
    expect(stores.sessions.setSessions).toHaveBeenCalledWith([]);
    expect(stores.sidecars.setSidecars).toHaveBeenCalledTimes(1);
    expect(stores.sidecars.setSidecars).toHaveBeenCalledWith([]);
  });

  test("'network:pending' with valid envelope routes to pending.setNetwork and reconciles pendingAction", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: NetworkPendingItemLike[] = [
      {
        requestId: "r1",
        sessionId: "s1",
        createdAt: "2026-01-01T00:00:00Z",
        target: { host: "example.com", port: 443 },
      },
      {
        requestId: "r2",
        sessionId: "s2",
        createdAt: "2026-01-01T00:00:01Z",
        target: { host: "example.com", port: 443 },
      },
    ];
    dispatch("network:pending", { items });

    expect(stores.pending.setNetwork).toHaveBeenCalledTimes(1);
    expect(stores.pending.setNetwork).toHaveBeenCalledWith(items);
    expect(stores.pendingAction.reconcile).toHaveBeenCalledTimes(1);
    expect(stores.pendingAction.reconcile).toHaveBeenCalledWith("network", [
      pendingRequestKey("network", "s1", "r1"),
      pendingRequestKey("network", "s2", "r2"),
    ]);
    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.sidecars.setSidecars).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
    expect(stores.audit.setEntries).not.toHaveBeenCalled();
  });

  test("'hostexec:pending' with valid envelope routes to pending.setHostExec and reconciles pendingAction", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: HostExecPendingItemLike[] = [
      {
        requestId: "x1",
        sessionId: "s1",
        createdAt: "2026-01-01T00:00:00Z",
        argv0: "git",
        args: ["push"],
      },
    ];
    dispatch("hostexec:pending", { items });

    expect(stores.pending.setHostExec).toHaveBeenCalledTimes(1);
    expect(stores.pending.setHostExec).toHaveBeenCalledWith(items);
    expect(stores.pendingAction.reconcile).toHaveBeenCalledTimes(1);
    expect(stores.pendingAction.reconcile).toHaveBeenCalledWith("hostexec", [
      pendingRequestKey("hostexec", "s1", "x1"),
    ]);
    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.sidecars.setSidecars).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.audit.setEntries).not.toHaveBeenCalled();
  });

  test("'terminal:sessions' with valid envelope routes to terminals.setDtachSessions", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: DtachSessionLike[] = [
      {
        name: "term-1",
        sessionId: "s1",
        socketPath: "/tmp/nas/s1.sock",
        createdAt: 1700000000000,
      },
    ];
    dispatch("terminal:sessions", { items });

    expect(stores.terminals.setDtachSessions).toHaveBeenCalledTimes(1);
    expect(stores.terminals.setDtachSessions).toHaveBeenCalledWith(items);
    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.sidecars.setSidecars).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
    expect(stores.pendingAction.reconcile).not.toHaveBeenCalled();
    expect(stores.audit.setEntries).not.toHaveBeenCalled();
  });

  test("'terminal:sessions' with invalid envelope is ignored", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    dispatch("terminal:sessions", {});
    dispatch("terminal:sessions", { items: "not-an-array" });
    dispatch("terminal:sessions", null);
    dispatch("terminal:sessions", 42);
    dispatch("terminal:sessions", undefined);

    expect(stores.terminals.setDtachSessions).not.toHaveBeenCalled();
  });

  test("malformed envelope (missing items / not an array / null / primitive) does not invoke any setter or reconcile", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    dispatch("containers", {});
    dispatch("containers", { items: "not-an-array" });
    dispatch("containers", null);
    dispatch("containers", 42);
    dispatch("network:pending", { other: [] });
    dispatch("hostexec:pending", undefined);
    dispatch("audit:logs", null);
    dispatch("audit:logs", { items: "not-an-array" });

    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.sidecars.setSidecars).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
    expect(stores.pendingAction.reconcile).not.toHaveBeenCalled();
    expect(stores.audit.setEntries).not.toHaveBeenCalled();
  });

  test("SSE_EVENT_NAMES exposes the dispatched event vocabulary in a stable order", () => {
    // The controller is event-name agnostic; this constant is what the
    // caller wires through `ConnectionDeps.eventNames`. Pin the contents
    // so a silent rename (e.g. dropping `hostexec:pending`) is caught.
    expect(SSE_EVENT_NAMES).toEqual([
      "containers",
      "network:pending",
      "hostexec:pending",
      "terminal:sessions",
      "audit:logs",
    ]);
  });

  test("unknown event names are ignored", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    dispatch("sessions", { items: [] });
    dispatch("", { items: [] });

    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.sidecars.setSidecars).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
    expect(stores.pendingAction.reconcile).not.toHaveBeenCalled();
    expect(stores.audit.setEntries).not.toHaveBeenCalled();
  });

  test("'audit:logs' with valid envelope routes to audit.setEntries", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: AuditLogEntryLike[] = [
      {
        id: "a1",
        timestamp: "2026-04-20T10:00:00.000Z",
        domain: "network",
        sessionId: "s1",
        requestId: "r1",
        decision: "allow",
        reason: "ok",
        target: "example.com:443",
      },
    ];
    dispatch("audit:logs", { items });

    expect(stores.audit.setEntries).toHaveBeenCalledTimes(1);
    expect(stores.audit.setEntries).toHaveBeenCalledWith(items);
    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.sidecars.setSidecars).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
    expect(stores.pendingAction.reconcile).not.toHaveBeenCalled();
    expect(stores.terminals.setDtachSessions).not.toHaveBeenCalled();
  });

  test("empty network snapshot reconciles with an empty key list", () => {
    // Pin: an empty snapshot still triggers reconcile so any prior
    // selected-scope / busy / error entries are cleared.
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);
    dispatch("network:pending", { items: [] });
    expect(stores.pendingAction.reconcile).toHaveBeenCalledTimes(1);
    expect(stores.pendingAction.reconcile).toHaveBeenCalledWith("network", []);
  });

  test("empty hostexec snapshot reconciles with an empty key list", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);
    dispatch("hostexec:pending", { items: [] });
    expect(stores.pendingAction.reconcile).toHaveBeenCalledTimes(1);
    expect(stores.pendingAction.reconcile).toHaveBeenCalledWith("hostexec", []);
  });

  test("empty audit snapshot still calls audit.setEntries with an empty list", () => {
    // Symmetric to the pending case: an empty snapshot must still hit
    // the setter so a previously-populated accordion is cleared.
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);
    dispatch("audit:logs", { items: [] });
    expect(stores.audit.setEntries).toHaveBeenCalledTimes(1);
    expect(stores.audit.setEntries).toHaveBeenCalledWith([]);
  });
});
