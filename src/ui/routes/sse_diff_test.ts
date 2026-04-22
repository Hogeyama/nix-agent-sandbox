import { expect, test } from "bun:test";
import type { AuditLogEntry } from "../../audit/types.ts";
import type { NasContainerInfo } from "../../domain/container.ts";
import type { HostExecPendingEntry } from "../../hostexec/types.ts";
import type { PendingEntry } from "../../network/protocol.ts";
import type { SessionsData, TerminalSessionInfo } from "../data.ts";
import {
  diffSnapshots,
  initialSnapshotState,
  type SnapshotInputs,
} from "./sse_diff.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNetworkEntry(suffix = "n1"): PendingEntry {
  return {
    version: 1,
    sessionId: `sess-${suffix}`,
    requestId: `req-${suffix}`,
    target: { host: "example.com", port: 443, scheme: "https" },
    method: "GET",
    requestKind: "http",
    state: "pending",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  } as unknown as PendingEntry;
}

function makeHostExecEntry(suffix = "h1"): HostExecPendingEntry {
  return {
    version: 1,
    sessionId: `sess-${suffix}`,
    requestId: `req-${suffix}`,
    approvalKey: `key-${suffix}`,
    ruleId: "rule-1",
    argv0: "git",
    args: ["status"],
    cwd: "/tmp",
    state: "pending",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

function makeTerminalSession(suffix = "t1"): TerminalSessionInfo {
  return {
    name: `term-${suffix}`,
    sessionId: `term-${suffix}`,
    socketPath: `/tmp/dtach/${suffix}.sock`,
    createdAt: 1700000000,
  };
}

function makeContainer(suffix = "c1"): NasContainerInfo {
  return {
    name: `nas-${suffix}`,
    running: true,
    labels: {},
    networks: ["bridge"],
    startedAt: "2025-01-01T00:00:00Z",
  };
}

function makeAudit(suffix = "a1"): AuditLogEntry {
  return {
    id: `id-${suffix}`,
    timestamp: "2025-01-01T00:00:00Z",
    domain: "network",
    sessionId: `sess-${suffix}`,
    requestId: `req-${suffix}`,
    decision: "allow",
    reason: "ok",
  };
}

const EMPTY_SESSIONS: SessionsData = { network: [], hostexec: [] };

function makeInputs(overrides: Partial<SnapshotInputs> = {}): SnapshotInputs {
  return {
    network: [],
    hostexec: [],
    sessions: EMPTY_SESSIONS,
    terminalSessions: [],
    containers: [],
    audit: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("1. initial state (all '') emits all 6 events in fixed order", () => {
  const prev = initialSnapshotState();
  const inputs = makeInputs();
  const { events, nextState } = diffSnapshots(prev, inputs);

  expect(events.map((e) => e.event)).toEqual([
    "network:pending",
    "hostexec:pending",
    "sessions",
    "terminal:sessions",
    "containers",
    "audit:logs",
  ]);
  // nextState fields are populated with the JSON of the empty inputs (not "").
  expect(nextState.network).toBe("[]");
  expect(nextState.hostexec).toBe("[]");
  expect(nextState.sessions).toBe('{"network":[],"hostexec":[]}');
  expect(nextState.terminalSessions).toBe("[]");
  expect(nextState.containers).toBe("[]");
  expect(nextState.audit).toBe("[]");
});

test("2. unchanged inputs emit no events and preserve prev state", () => {
  const seed = initialSnapshotState();
  const inputs = makeInputs();
  const { nextState: prev } = diffSnapshots(seed, inputs);

  const { events, nextState } = diffSnapshots(prev, inputs);
  expect(events).toEqual([]);
  expect(nextState).toEqual(prev);
});

test("3. only network changes → 1 event with name 'network:pending'", () => {
  const seed = initialSnapshotState();
  const baseline = makeInputs();
  const { nextState: prev } = diffSnapshots(seed, baseline);

  const next = makeInputs({ network: [makeNetworkEntry()] });
  const { events, nextState } = diffSnapshots(prev, next);

  expect(events.length).toBe(1);
  expect(events[0]?.event).toBe("network:pending");
  // other state fields must be carried forward unchanged.
  expect(nextState.hostexec).toBe(prev.hostexec);
  expect(nextState.sessions).toBe(prev.sessions);
  expect(nextState.terminalSessions).toBe(prev.terminalSessions);
  expect(nextState.containers).toBe(prev.containers);
  expect(nextState.audit).toBe(prev.audit);
});

test("4. only hostexec changes → 1 event with name 'hostexec:pending'", () => {
  const seed = initialSnapshotState();
  const baseline = makeInputs();
  const { nextState: prev } = diffSnapshots(seed, baseline);

  const next = makeInputs({ hostexec: [makeHostExecEntry()] });
  const { events, nextState } = diffSnapshots(prev, next);

  expect(events.length).toBe(1);
  expect(events[0]?.event).toBe("hostexec:pending");
  expect(nextState.network).toBe(prev.network);
});

test("5. only sessions changes → 1 event with name 'sessions'", () => {
  const seed = initialSnapshotState();
  const baseline = makeInputs();
  const { nextState: prev } = diffSnapshots(seed, baseline);

  const next = makeInputs({
    sessions: { network: [makeNetworkEntry()] as never, hostexec: [] },
  });
  const { events, nextState } = diffSnapshots(prev, next);

  expect(events.length).toBe(1);
  expect(events[0]?.event).toBe("sessions");
  expect(nextState.network).toBe(prev.network);
});

test("6. only terminalSessions changes → 1 event with name 'terminal:sessions'", () => {
  const seed = initialSnapshotState();
  const baseline = makeInputs();
  const { nextState: prev } = diffSnapshots(seed, baseline);

  const next = makeInputs({ terminalSessions: [makeTerminalSession()] });
  const { events, nextState } = diffSnapshots(prev, next);

  expect(events.length).toBe(1);
  expect(events[0]?.event).toBe("terminal:sessions");
  expect(nextState.network).toBe(prev.network);
});

test("7. only containers changes → 1 event with name 'containers'", () => {
  const seed = initialSnapshotState();
  const baseline = makeInputs();
  const { nextState: prev } = diffSnapshots(seed, baseline);

  const next = makeInputs({ containers: [makeContainer()] });
  const { events, nextState } = diffSnapshots(prev, next);

  expect(events.length).toBe(1);
  expect(events[0]?.event).toBe("containers");
  expect(nextState.network).toBe(prev.network);
});

test("8. only audit changes → 1 event with name 'audit:logs'", () => {
  const seed = initialSnapshotState();
  const baseline = makeInputs();
  const { nextState: prev } = diffSnapshots(seed, baseline);

  const next = makeInputs({ audit: [makeAudit()] });
  const { events, nextState } = diffSnapshots(prev, next);

  expect(events.length).toBe(1);
  expect(events[0]?.event).toBe("audit:logs");
  expect(nextState.network).toBe(prev.network);
});

test("9. partial sessions change ({network:[]} → {network:[entry]}) emits sessions", () => {
  const seed = initialSnapshotState();
  // Baseline: empty sessions.
  const baseline = makeInputs({
    sessions: { network: [], hostexec: [] },
  });
  const { nextState: prev } = diffSnapshots(seed, baseline);

  const next = makeInputs({
    sessions: { network: [makeNetworkEntry()] as never, hostexec: [] },
  });
  const { events } = diffSnapshots(prev, next);

  expect(events.length).toBe(1);
  expect(events[0]?.event).toBe("sessions");
});

test("10. audit undefined + other 5 change → no audit event, 5 events emitted, nextState.audit preserved", () => {
  const seed = initialSnapshotState();
  // First seed prev with non-empty audit baseline.
  const baseline = makeInputs({ audit: [makeAudit("base")] });
  const { nextState: prev } = diffSnapshots(seed, baseline);
  expect(prev.audit).toBe(JSON.stringify([makeAudit("base")]));

  const next = makeInputs({
    network: [makeNetworkEntry()],
    hostexec: [makeHostExecEntry()],
    sessions: { network: [makeNetworkEntry()] as never, hostexec: [] },
    terminalSessions: [makeTerminalSession()],
    containers: [makeContainer()],
    audit: undefined,
  });
  const { events, nextState } = diffSnapshots(prev, next);

  expect(events.map((e) => e.event)).toEqual([
    "network:pending",
    "hostexec:pending",
    "sessions",
    "terminal:sessions",
    "containers",
  ]);
  expect(nextState.audit).toBe(prev.audit);
});

test("11. audit undefined with prev.audit '' → no audit event, nextState.audit stays ''", () => {
  const prev = initialSnapshotState();
  expect(prev.audit).toBe("");
  const inputs = makeInputs({ audit: undefined });
  const { events, nextState } = diffSnapshots(prev, inputs);

  expect(events.some((e) => e.event === "audit:logs")).toBe(false);
  expect(nextState.audit).toBe("");
});

test("12. payload shape: network event data === { items: [...] } (items wrapper)", () => {
  const prev = initialSnapshotState();
  const entry = makeNetworkEntry();
  const inputs = makeInputs({ network: [entry] });
  const { events } = diffSnapshots(prev, inputs);

  const networkEv = events.find((e) => e.event === "network:pending");
  expect(networkEv).toBeDefined();
  expect(networkEv?.data).toEqual({ items: [entry] });
});

test("13. payload shape: sessions event data is the raw SessionsData (no items wrapper)", () => {
  const prev = initialSnapshotState();
  const sessions: SessionsData = {
    network: [makeNetworkEntry()] as never,
    hostexec: [],
  };
  const inputs = makeInputs({ sessions });
  const { events } = diffSnapshots(prev, inputs);

  const sessEv = events.find((e) => e.event === "sessions");
  expect(sessEv).toBeDefined();
  // Pin the asymmetric contract: data === sessions object literal, NOT { items: ... }.
  expect(sessEv?.data).toEqual(sessions);
  expect(
    (sessEv?.data as unknown as Record<string, unknown>).items,
  ).toBeUndefined();
});

test("14. nextState round-trip: feeding nextState + same inputs yields no events", () => {
  const seed = initialSnapshotState();
  const inputs = makeInputs({
    network: [makeNetworkEntry()],
    hostexec: [makeHostExecEntry()],
    sessions: { network: [makeNetworkEntry()] as never, hostexec: [] },
    terminalSessions: [makeTerminalSession()],
    containers: [makeContainer()],
    audit: [makeAudit()],
  });
  const { nextState } = diffSnapshots(seed, inputs);

  const second = diffSnapshots(nextState, inputs);
  expect(second.events).toEqual([]);
});

test("15. event ordering is deterministic when all 6 change", () => {
  // Seed prev with a non-trivial baseline so all 6 are guaranteed to differ.
  const seed = initialSnapshotState();
  const baseline = makeInputs({
    network: [makeNetworkEntry("base-n")],
    hostexec: [makeHostExecEntry("base-h")],
    sessions: {
      network: [makeNetworkEntry("base-s")] as never,
      hostexec: [],
    },
    terminalSessions: [makeTerminalSession("base-t")],
    containers: [makeContainer("base-c")],
    audit: [makeAudit("base-a")],
  });
  const { nextState: prev } = diffSnapshots(seed, baseline);

  const next = makeInputs({
    network: [makeNetworkEntry("new-n")],
    hostexec: [makeHostExecEntry("new-h")],
    sessions: {
      network: [makeNetworkEntry("new-s")] as never,
      hostexec: [],
    },
    terminalSessions: [makeTerminalSession("new-t")],
    containers: [makeContainer("new-c")],
    audit: [makeAudit("new-a")],
  });
  const { events } = diffSnapshots(prev, next);

  expect(events.map((e) => e.event)).toEqual([
    "network:pending",
    "hostexec:pending",
    "sessions",
    "terminal:sessions",
    "containers",
    "audit:logs",
  ]);
});
