/**
 * Solid store for the pending pane (network + host-exec approval queues).
 *
 * Normalizes raw pending payloads into UI-facing rows and exposes them
 * via accessor functions so consumers cannot mutate the underlying
 * Solid store shape directly.
 */

import { createStore } from "solid-js/store";
import { pendingRequestKey } from "./pendingRequestKey";
import { shortenSessionId } from "./sessionId";
import type { HostExecPendingItemLike, NetworkPendingItemLike } from "./types";

export type NetworkPendingRow = {
  // Stable composite identity `(domain, sessionId, requestId)` produced by
  // `pendingRequestKey`. Used to key per-card UI state (selected scope,
  // busy flag, error message) so entries do not collide with hostexec
  // rows that happen to share a `requestId`.
  key: string;
  // Alias of `requestId`. Retained as an informational handle for any
  // consumer that already reads `id` from the row; per-card state lookup
  // uses `key` instead.
  id: string;
  sessionId: string;
  sessionShortId: string;
  sessionName: string | null;
  verb: string;
  summary: string;
  createdAtMs: number | null; // null when ISO parse fails
};

export type HostExecPendingRow = {
  // See `NetworkPendingRow.key`.
  key: string;
  // See `NetworkPendingRow.id`.
  id: string;
  sessionId: string;
  sessionShortId: string;
  sessionName: string | null;
  command: string; // argv joined by space, presentation only
  createdAtMs: number | null;
};

export function normalizeNetworkPending(
  items: NetworkPendingItemLike[],
): NetworkPendingRow[] {
  return items.map((it) => ({
    key: pendingRequestKey("network", it.sessionId, it.requestId),
    id: it.requestId,
    sessionId: it.sessionId,
    sessionShortId: shortenSessionId(it.sessionId),
    sessionName: null,
    verb: (it.method ?? "GET").toUpperCase(),
    summary: `${it.target.host}:${it.target.port}`,
    createdAtMs: parseIsoToMs(it.createdAt),
  }));
}

export function normalizeHostExecPending(
  items: HostExecPendingItemLike[],
): HostExecPendingRow[] {
  return items.map((it) => ({
    key: pendingRequestKey("hostexec", it.sessionId, it.requestId),
    id: it.requestId,
    sessionId: it.sessionId,
    sessionShortId: shortenSessionId(it.sessionId),
    sessionName: null,
    command: [it.argv0, ...it.args].join(" "),
    createdAtMs: parseIsoToMs(it.createdAt),
  }));
}

function parseIsoToMs(iso: string): number | null {
  const t = Date.parse(iso);
  // Date.parse returns NaN for unparseable input; surface that explicitly
  // as null so the view layer can render a placeholder instead of NaN.
  return Number.isFinite(t) ? t : null;
}

export type PendingStore = {
  network: () => NetworkPendingRow[];
  hostexec: () => HostExecPendingRow[];
  setNetwork: (items: NetworkPendingItemLike[]) => void;
  setHostExec: (items: HostExecPendingItemLike[]) => void;
  // Drop a row by `requestId` after the server has confirmed an
  // approve/deny, so the UI does not have to wait for the next ~2s SSE
  // poll. The next snapshot overwrites the whole array anyway, so any
  // drift here is self-correcting.
  removeNetwork: (requestId: string) => void;
  removeHostExec: (requestId: string) => void;
};

export function createPendingStore(): PendingStore {
  const [state, setState] = createStore<{
    network: NetworkPendingRow[];
    hostexec: HostExecPendingRow[];
  }>({ network: [], hostexec: [] });
  return {
    network: () => state.network,
    hostexec: () => state.hostexec,
    setNetwork: (items) => setState("network", normalizeNetworkPending(items)),
    setHostExec: (items) =>
      setState("hostexec", normalizeHostExecPending(items)),
    removeNetwork: (requestId) =>
      setState("network", (rows) => rows.filter((r) => r.id !== requestId)),
    removeHostExec: (requestId) =>
      setState("hostexec", (rows) => rows.filter((r) => r.id !== requestId)),
  };
}
