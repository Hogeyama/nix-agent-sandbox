/**
 * Pure aggregation helper for the SessionsPane pending indicator.
 *
 * Folds the two pending queues (network + host-exec) into a per-session
 * count map so the row indicator can render `{network, hostexec}` chips
 * without re-scanning the queues for every row. The helper is shape-only
 * (`{sessionId: string}[]`) so test fixtures can construct minimal rows
 * instead of mirroring the full `NetworkPendingRow` / `HostExecPendingRow`
 * shapes.
 */

export interface PendingCount {
  network: number;
  hostexec: number;
}

export function summarizePendingBySession(
  network: readonly { sessionId: string }[],
  hostexec: readonly { sessionId: string }[],
): Map<string, PendingCount> {
  const summary = new Map<string, PendingCount>();
  for (const row of network) {
    const entry = summary.get(row.sessionId);
    if (entry === undefined) {
      summary.set(row.sessionId, { network: 1, hostexec: 0 });
    } else {
      entry.network += 1;
    }
  }
  for (const row of hostexec) {
    const entry = summary.get(row.sessionId);
    if (entry === undefined) {
      summary.set(row.sessionId, { network: 0, hostexec: 1 });
    } else {
      entry.hostexec += 1;
    }
  }
  return summary;
}
