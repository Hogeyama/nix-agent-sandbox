/**
 * Pure dispatch from SSE named events to frontend-next stores.
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
 * Event names not present in the switch (for example `sessions` or
 * `audit:logs`) fall into the default branch and are no-ops.
 */

import type { PendingStore } from "../stores/pendingStore";
import type { SessionsStore } from "../stores/sessionsStore";
import type { TerminalsStore } from "../stores/terminalsStore";
import type {
  ContainerInfoLike,
  DtachSessionLike,
  HostExecPendingItemLike,
  NetworkPendingItemLike,
} from "../stores/types";

export interface SseDispatchStores {
  sessions: SessionsStore;
  pending: PendingStore;
  terminals: TerminalsStore;
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
        if (items !== null) stores.sessions.setSessions(items);
        return;
      }
      case "network:pending": {
        const items = extractItems<NetworkPendingItemLike>(data);
        if (items !== null) stores.pending.setNetwork(items);
        return;
      }
      case "hostexec:pending": {
        const items = extractItems<HostExecPendingItemLike>(data);
        if (items !== null) stores.pending.setHostExec(items);
        return;
      }
      case "terminal:sessions": {
        const items = extractItems<DtachSessionLike>(data);
        if (items !== null) stores.terminals.setDtachSessions(items);
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
