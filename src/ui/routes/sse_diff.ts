/**
 * SSE snapshot diffing for the `/events` route's poll loop.
 *
 * `diffSnapshots(prev, next)` compares the previous serialized snapshot state
 * against the freshly-fetched inputs and returns the events that should be
 * sent over the wire plus the new state to feed back on the next poll.
 *
 * Design constraints:
 * - Equality is `JSON.stringify` based; deep equal would be a future
 *   optimization.
 * - Event names are fixed and ordered: `network:pending` →
 *   `hostexec:pending` → `sessions` → `terminal:sessions` → `containers` →
 *   `audit:logs`.
 * - Payload shapes are non-symmetric: `sessions` emits the raw `SessionsData`
 *   object as the SSE `data` field, while the other five events wrap their
 *   array in `{ items: [...] }`.
 * - When `audit` is `undefined` (i.e. the audit fetch failed in the caller),
 *   the `audit:logs` event is suppressed and `nextState.audit` is preserved
 *   from `prev.audit`.
 *
 * The function is a pure (input → output) transformation: no module-level
 * mutable state, no IO, no timers. The connection's `state` lives inside
 * the `start(controller)` closure of the SSE route.
 */

import type { AuditLogEntry } from "../../audit/types.ts";
import type { NasContainerInfo } from "../../domain/container.ts";
import type { HostExecPendingEntry } from "../../hostexec/types.ts";
import type { PendingEntry } from "../../network/protocol.ts";
import type { SessionsData, TerminalSessionInfo } from "../data.ts";

/**
 * Per-key serialized JSON of the last snapshot we sent on the wire. Used
 * solely for change detection on the next poll.
 */
export type SnapshotState = Readonly<{
  network: string;
  hostexec: string;
  sessions: string;
  terminalSessions: string;
  containers: string;
  audit: string;
}>;

/**
 * Freshly-fetched snapshot inputs. `audit` is optional: the caller (e.g. the
 * SSE route) suppresses fetch errors and passes `undefined` here, which
 * suppresses the `audit:logs` event for this poll.
 */
export type SnapshotInputs = {
  network: PendingEntry[];
  hostexec: HostExecPendingEntry[];
  sessions: SessionsData;
  terminalSessions: TerminalSessionInfo[];
  containers: NasContainerInfo[];
  audit?: AuditLogEntry[];
};

/**
 * Fixed wire-name list. Surface as a `const` tuple so a typo regression in
 * any of the event names becomes a TS error at the `SseEvent` discriminated
 * union below.
 */
export const SSE_EVENT_NAMES = [
  "network:pending",
  "hostexec:pending",
  "sessions",
  "terminal:sessions",
  "containers",
  "audit:logs",
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/**
 * One SSE event ready to be `send(event, data)`-ed. Note the deliberate
 * payload-shape asymmetry: `sessions` carries the raw `SessionsData`
 * object, while the other five events wrap their array in `{ items }`.
 */
export type SseEvent =
  | { event: "network:pending"; data: { items: PendingEntry[] } }
  | { event: "hostexec:pending"; data: { items: HostExecPendingEntry[] } }
  | { event: "sessions"; data: SessionsData }
  | { event: "terminal:sessions"; data: { items: TerminalSessionInfo[] } }
  | { event: "containers"; data: { items: NasContainerInfo[] } }
  | { event: "audit:logs"; data: { items: AuditLogEntry[] } };

/** Initial state to seed `diffSnapshots` on the first poll of a connection. */
export function initialSnapshotState(): SnapshotState {
  return {
    network: "",
    hostexec: "",
    sessions: "",
    terminalSessions: "",
    containers: "",
    audit: "",
  };
}

/**
 * Compare `prev` against `next` and return the SSE events to emit plus the
 * new snapshot state to thread into the next call.
 *
 * Contract:
 * - `events` is ordered per {@link SSE_EVENT_NAMES}.
 * - Unchanged keys are absent from `events` and carry their previous JSON
 *   string forward in `nextState`.
 * - `audit === undefined` suppresses the `audit:logs` event and preserves
 *   `prev.audit` in `nextState.audit`.
 */
export function diffSnapshots(
  prev: SnapshotState,
  next: SnapshotInputs,
): { events: SseEvent[]; nextState: SnapshotState } {
  const events: SseEvent[] = [];

  const networkJson = JSON.stringify(next.network);
  const networkChanged = networkJson !== prev.network;
  if (networkChanged) {
    events.push({ event: "network:pending", data: { items: next.network } });
  }

  const hostexecJson = JSON.stringify(next.hostexec);
  const hostexecChanged = hostexecJson !== prev.hostexec;
  if (hostexecChanged) {
    events.push({ event: "hostexec:pending", data: { items: next.hostexec } });
  }

  const sessionsJson = JSON.stringify(next.sessions);
  const sessionsChanged = sessionsJson !== prev.sessions;
  if (sessionsChanged) {
    events.push({ event: "sessions", data: next.sessions });
  }

  const terminalSessionsJson = JSON.stringify(next.terminalSessions);
  const terminalSessionsChanged =
    terminalSessionsJson !== prev.terminalSessions;
  if (terminalSessionsChanged) {
    events.push({
      event: "terminal:sessions",
      data: { items: next.terminalSessions },
    });
  }

  const containersJson = JSON.stringify(next.containers);
  const containersChanged = containersJson !== prev.containers;
  if (containersChanged) {
    events.push({ event: "containers", data: { items: next.containers } });
  }

  // Audit is optional: undefined means the caller's audit fetch failed and
  // we must suppress the event AND keep prev.audit so a later successful
  // fetch with the same payload still counts as "no change" (rather than
  // reverting to "" and re-emitting on the next poll).
  let auditJson = prev.audit;
  if (next.audit !== undefined) {
    const candidate = JSON.stringify(next.audit);
    if (candidate !== prev.audit) {
      events.push({ event: "audit:logs", data: { items: next.audit } });
    }
    auditJson = candidate;
  }

  const nextState: SnapshotState = {
    network: networkChanged ? networkJson : prev.network,
    hostexec: hostexecChanged ? hostexecJson : prev.hostexec,
    sessions: sessionsChanged ? sessionsJson : prev.sessions,
    terminalSessions: terminalSessionsChanged
      ? terminalSessionsJson
      : prev.terminalSessions,
    containers: containersChanged ? containersJson : prev.containers,
    audit: auditJson,
  };

  return { events, nextState };
}
