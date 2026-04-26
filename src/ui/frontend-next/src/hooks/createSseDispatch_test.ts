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
import type {
  ContainerInfoLike,
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
  return { sessions, pending };
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
        id: "r1",
        sessionId: "s1",
        createdAt: "2026-01-01T00:00:00Z",
        host: "example.com",
        port: 443,
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
        id: "x1",
        sessionId: "s1",
        createdAt: "2026-01-01T00:00:00Z",
        argv: ["git", "push"],
      },
    ];
    dispatch("hostexec:pending", { items });

    expect(stores.pending.setHostExec).toHaveBeenCalledTimes(1);
    expect(stores.pending.setHostExec).toHaveBeenCalledWith(items);
    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
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
    ]);
  });

  test("unknown event names are ignored", () => {
    const stores = makeFakeStores();
    const dispatch = createSseDispatch(stores);

    dispatch("sessions", { items: [] });
    dispatch("audit:logs", { items: [] });
    dispatch("terminal:sessions", { items: [] });
    dispatch("", { items: [] });

    expect(stores.sessions.setSessions).not.toHaveBeenCalled();
    expect(stores.pending.setNetwork).not.toHaveBeenCalled();
    expect(stores.pending.setHostExec).not.toHaveBeenCalled();
  });
});
