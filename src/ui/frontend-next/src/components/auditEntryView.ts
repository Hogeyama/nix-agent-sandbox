/**
 * Presentation helpers for audit log rows in the pending pane accordion.
 *
 * Mirrors the legacy `formatTimestamp` in
 * `src/ui/frontend/src/components/AuditTab.tsx` so the two frontends
 * format timestamps identically: local TZ, `YYYY/MM/DD HH:mm:ss`, with
 * a fallback to the raw ISO string for unparseable input.
 */

import type { AuditLogEntryRow } from "../stores/auditStore";

/**
 * Format an audit row's `timestamp` in local TZ as
 * `YYYY/MM/DD HH:mm:ss`. Returns the raw input on parse failure.
 *
 * `nowMs` is reserved for future relative-time variants and is ignored
 * by the current implementation; the signature is fixed now so adding
 * relative time later does not become a breaking change.
 */
export function formatAuditEntry(
  entry: { timestamp: string },
  _nowMs?: number,
): string {
  const iso = entry.timestamp;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

/**
 * Compose the row's summary cell. Network rows carry `target`, hostexec
 * rows carry `command`; the empty string is a safe fallback when both
 * are absent (the daemon is supposed to populate one or the other).
 */
export function summaryFor(row: AuditLogEntryRow): string {
  return row.target ?? row.command ?? "";
}
