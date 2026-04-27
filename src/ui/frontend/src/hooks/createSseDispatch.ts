/**
 * Pure dispatch from SSE named events to the frontend stores.
 *
 * The connection controller (`createConnectionController`) is responsible
 * for the EventSource lifecycle and for JSON-parsing each named event's
 * payload. This module is the layer above: it knows the shape of the
 * stores and which event name maps to which setter. Splitting the two
 * keeps controller logic free of store knowledge and lets each layer be
 * tested in isolation.
 *
 * Payloads whose shape does not match the expected `{ items: [...] }`
 * envelope are dropped: the corresponding store is not updated. Field-
 * level normalization (e.g. `?? null` for optional fields) is owned by
 * each store's normalizer, so this dispatch only enforces the outer
 * envelope.
 *
 * For pending events (`network:pending` and `hostexec:pending`) the
 * dispatcher additionally drives the per-card UI state in
 * `pendingActionStore`: every snapshot is followed by a call to
 * `reconcile(domain, snapshotKeys)` so rows that disappeared from the
 * snapshot drop their selected scope, busy flag, and error message,
 * while rows still present keep their state untouched.
 *
 * Event names not present in the switch (for example `sessions`) fall
 * into the default branch and are no-ops.
 */

import type { AuditStore } from "../stores/auditStore";
import type { PendingActionStore } from "../stores/pendingActionStore";
import { pendingRequestKey } from "../stores/pendingRequestKey";
import type { PendingStore } from "../stores/pendingStore";
import type { SessionsStore } from "../stores/sessionsStore";
import type { SidecarsStore } from "../stores/sidecarsStore";
import type { TerminalsStore } from "../stores/terminalsStore";
import type {
  AuditLogEntryLike,
  ContainerInfoLike,
  DtachSessionLike,
  HostExecPendingItemLike,
  NetworkPendingItemLike,
} from "../stores/types";

export interface SseDispatchStores {
  sessions: SessionsStore;
  sidecars: SidecarsStore;
  pending: PendingStore;
  pendingAction: PendingActionStore;
  terminals: TerminalsStore;
  audit: AuditStore;
}

export type SseDispatch = (name: string, data: unknown) => void;

/**
 * The set of SSE event names this dispatch consumes. Owned by the
 * dispatch layer (not the controller) so the lifecycle layer stays
 * agnostic about application vocabulary; callers pass this through
 * `ConnectionDeps.eventNames` to wire the subscriptions.
 */
export const SSE_EVENT_NAMES = [
  "containers",
  "network:pending",
  "hostexec:pending",
  "terminal:sessions",
  "audit:logs",
] as const;

/**
 * Build a dispatcher closed over the supplied stores. The returned
 * function matches `ConnectionDeps["onEvent"]` and is intended to be
 * passed directly to `useConnection(url, dispatch)`.
 */
export function createSseDispatch(stores: SseDispatchStores): SseDispatch {
  return (name, data) => {
    switch (name) {
      case "containers": {
        const items = extractItems<ContainerInfoLike>(data);
        if (items === null) return;
        // The `containers` snapshot mixes session (agent-kind) and
        // sidecar (dind / proxy / envoy) entries. Each store filters
        // by kind, so the two views are disjoint by construction.
        // Both setters are called on every snapshot — including the
        // empty array — so a snapshot that has lost all entries of
        // one kind correctly clears the corresponding store.
        stores.sessions.setSessions(items);
        stores.sidecars.setSidecars(items);
        return;
      }
      case "network:pending": {
        const items = extractItems<NetworkPendingItemLike>(data);
        if (items === null) return;
        stores.pending.setNetwork(items);
        // Reconcile per-card state immediately after the snapshot is
        // applied so a removed row cannot leave a dangling scope chip
        // selection or stale error message.
        stores.pendingAction.reconcile(
          "network",
          items.map((it) =>
            pendingRequestKey("network", it.sessionId, it.requestId),
          ),
        );
        return;
      }
      case "hostexec:pending": {
        const items = extractItems<HostExecPendingItemLike>(data);
        if (items === null) return;
        stores.pending.setHostExec(items);
        stores.pendingAction.reconcile(
          "hostexec",
          items.map((it) =>
            pendingRequestKey("hostexec", it.sessionId, it.requestId),
          ),
        );
        return;
      }
      case "terminal:sessions": {
        const items = extractItems<DtachSessionLike>(data);
        if (items !== null) stores.terminals.setDtachSessions(items);
        return;
      }
      case "audit:logs": {
        const items = extractItems<AuditLogEntryLike>(data);
        if (items !== null) stores.audit.setEntries(items);
        return;
      }
      default:
        return;
    }
  };
}

/**
 * Validate the outer `{ items: T[] }` envelope and return the array, or
 * `null` if the payload is not an object or `items` is not an array.
 */
function extractItems<T>(data: unknown): T[] | null {
  if (data === null || typeof data !== "object") return null;
  const candidate = (data as { items?: unknown }).items;
  if (!Array.isArray(candidate)) return null;
  return candidate as T[];
}
