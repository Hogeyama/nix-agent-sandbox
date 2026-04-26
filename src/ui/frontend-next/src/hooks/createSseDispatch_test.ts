/**
 * Tests for `createSseDispatch`.
 *
 * Pin the dispatch contract: the three event names consumed by the
 * sessions and pending panes route to the matching store setter,
 * malformed envelopes drop the payload silently (per design: store
 * state is not touched), and unknown event names are no-ops.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
  PendingStore,
} from "../stores/pendingStore";
import type { SessionsStore } from "../stores/sessionsStore";
import type { TerminalsStore } from "../stores/terminalsStore";
import type {
  ContainerInfoLike,
  DtachSessionLike,
  HostExecPendingItemLike,
  NetworkPendingItemLike,
  SessionRow,
} from "../stores/types";
import { createSseDispatch, SSE_EVENT_NAMES } from "./createSseDispatch";

interface FakeStores {
  sessions: SessionsStore & { setSessions: ReturnType<typeof mock> };
  pending: PendingStore & {
    setNetwork: ReturnType<typeof mock>;
    setHostExec: ReturnType<typeof mock>;
  };
  terminals: TerminalsStore & {
    setDtachSessions: ReturnType<typeof mock>;
  };
}

function makeFakeStores(): FakeStores {
  const sessions: FakeStores["sessions"] = {
    rows: () => [] as SessionRow[],
    setSessions: mock((_items: ContainerInfoLike[]) => {}),
  };
  const pending: FakeStores["pending"] = {
    network: () => [] as NetworkPendingRow[],
    hostexec: () => [] as HostExecPendingRow[],
    setNetwork: mock((_items: NetworkPendingItemLike[]) => {}),
    setHostExec: mock((_items: HostExecPendingItemLike[]) => {}),
  };
  const terminals: FakeStores["terminals"] = {
    dtachSessions: () => [] as DtachSessionLike[],
    activeId: () => null,
    pendingActivateId: () => null,
    setDtachSessions: mock((_items: DtachSessionLike[]) => {}),
    requestActivate: (_id: string) => {},
    setActive: (_id: string | null) => {},
    selectSession: (_id: string) => {},
  };
  return { sessions, pending, terminals };
}

describe("createSseDispatch", () => {
  test("'containers' with valid envelope routes to sessions.setSessions", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: ContainerInfoLike[] = [
      { name: "c1", running: true, labels: { "nas.kind": "agent" } },
    ];
    dispatch("containers", { items });

    expect(stores.sessions.setSessions).toHaveBeenCalledTimes(1);
    expect(stores.sessions.setSessions).toHaveBeenCalledWith(items);
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
  });

  test("'network:pending' with valid envelope routes to pending.setNetwork", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    const items: NetworkPendingItemLike[] = [
      {
        requestId: "r1",
        sessionId: "s1",
        createdAt: "2026-01-01T00:00:00Z",
        target: { host: "example.com", port: 443 },
      },
    ];
    dispatch("network:pending", { items });

    expect(stores.pending.setNetwork).toHaveBeenCalledTimes(1);
    expect(stores.pending.setNetwork).toHaveBeenCalledWith(items);
    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
  });

  test("'hostexec:pending' with valid envelope routes to pending.setHostExec", () => {
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
    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
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
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
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

  test("malformed envelope (missing items / not an array / null / primitive) does not invoke any setter", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    dispatch("containers", {});
    dispatch("containers", { items: "not-an-array" });
    dispatch("containers", null);
    dispatch("containers", 42);
    dispatch("network:pending", { other: [] });
    dispatch("hostexec:pending", undefined);

    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
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
    ]);
  });

  test("unknown event names are ignored", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    dispatch("sessions", { items: [] });
    dispatch("audit:logs", { items: [] });
    dispatch("", { items: [] });

    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
  });
});
