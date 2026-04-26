/**
 * Solid store for the pending pane (network + host-exec approval queues).
 *
 * Normalizes raw pending payloads into UI-facing rows and exposes them
 * via accessor functions so consumers cannot mutate the underlying
 * Solid store shape directly.
 */

import { createStore } from "solid-js/store";
import { shortenSessionId } from "./sessionId";
import type { HostExecPendingItemLike, NetworkPendingItemLike } from "./types";

export type NetworkPendingRow = {
  id: string;
  sessionId: string;
  sessionShortId: string;
  sessionName: string | null;
  verb: string;
  summary: string;
  createdAtMs: number | null; // null when ISO parse fails
};

export type HostExecPendingRow = {
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
    id: it.id,
    sessionId: it.sessionId,
    sessionShortId: shortenSessionId(it.sessionId),
    sessionName: it.sessionName ?? null,
    verb: (it.method ?? "GET").toUpperCase(),
    summary: `${it.host}:${it.port}`,
    createdAtMs: parseIsoToMs(it.createdAt),
  }));
}

export function normalizeHostExecPending(
  items: HostExecPendingItemLike[],
): HostExecPendingRow[] {
  return items.map((it) => ({
    id: it.id,
    sessionId: it.sessionId,
    sessionShortId: shortenSessionId(it.sessionId),
    sessionName: it.sessionName ?? null,
    command: it.argv.join(" "),
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
  };
}
