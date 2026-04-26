/**
 * Solid store for the audit accordion in the pending pane.
 *
 * Holds the most recent 50 entries by `timestamp` (ISO-8601). The
 * backend snapshot is sent in ascending order (`src/audit/store.ts`);
 * the store sorts descending (newest first) before slicing so the
 * recent-50 trim is "take the 50 newest" regardless of input order.
 *
 * Normalization (the wire-shape `AuditLogEntryLike` to the view-row
 * `AuditLogEntryRow`) happens at write time inside `setEntries`,
 * mirroring `pendingStore.setNetwork` / `setHostExec`. For now the row
 * shape is structurally identical to the wire shape; the indirection
 * is preserved so future view-only fields can be added without
 * touching the wire type.
 */

import { createStore } from "solid-js/store";
import type { AuditLogEntryLike } from "./types";

const RECENT_LIMIT = 50;

export type AuditLogEntryRow = {
  id: string;
  timestamp: string;
  domain: "network" | "hostexec";
  sessionId: string;
  requestId: string;
  decision: "allow" | "deny";
  reason: string;
  scope: string | null;
  target: string | null;
  command: string | null;
};

export function normalizeAuditEntries(
  items: AuditLogEntryLike[],
): AuditLogEntryRow[] {
  // Newest first. Comparing ISO-8601 timestamp strings lexicographically
  // matches numeric ordering as long as every entry uses the same format
  // (which the daemon guarantees).
  const sorted = items.slice().sort((a, b) => {
    if (a.timestamp < b.timestamp) return 1;
    if (a.timestamp > b.timestamp) return -1;
    return 0;
  });
  const trimmed = sorted.slice(0, RECENT_LIMIT);
  return trimmed.map((it) => ({
    id: it.id,
    timestamp: it.timestamp,
    domain: it.domain,
    sessionId: it.sessionId,
    requestId: it.requestId,
    decision: it.decision,
    reason: it.reason,
    scope: it.scope ?? null,
    target: it.target ?? null,
    command: it.command ?? null,
  }));
}

export type AuditStore = {
  entries: () => AuditLogEntryRow[];
  setEntries: (items: AuditLogEntryLike[]) => void;
};

export function createAuditStore(): AuditStore {
  const [state, setState] = createStore<{ entries: AuditLogEntryRow[] }>({
    entries: [],
  });
  return {
    entries: () => state.entries,
    setEntries: (items) => setState("entries", normalizeAuditEntries(items)),
  };
}
