import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";

type NetworkNotificationRow = Pick<
  NetworkPendingRow,
  "sessionId" | "sessionShortId" | "createdAtMs" | "verb" | "summary"
>;

type HostExecNotificationRow = Pick<
  HostExecPendingRow,
  "sessionId" | "sessionShortId" | "createdAtMs" | "command"
>;

export type PendingNotificationGroup = {
  sessionId: string;
  sessionShortId: string;
  network: number;
  hostexec: number;
  latestSummary: string;
  latestAt: number;
};

export function groupPendingNotifications(
  network: readonly NetworkNotificationRow[],
  hostexec: readonly HostExecNotificationRow[],
): PendingNotificationGroup[] {
  const bySession = new Map<string, PendingNotificationGroup>();

  const add = (
    row: NetworkNotificationRow | HostExecNotificationRow,
    kind: "network" | "hostexec",
    summary: string,
  ) => {
    const latestAt = row.createdAtMs ?? 0;
    const current = bySession.get(row.sessionId);
    if (current === undefined) {
      bySession.set(row.sessionId, {
        sessionId: row.sessionId,
        sessionShortId: row.sessionShortId,
        network: kind === "network" ? 1 : 0,
        hostexec: kind === "hostexec" ? 1 : 0,
        latestSummary: summary,
        latestAt,
      });
      return;
    }
    current[kind] += 1;
    if (latestAt >= current.latestAt) {
      current.latestAt = latestAt;
      current.latestSummary = summary;
    }
  };

  for (const row of network) {
    add(row, "network", `${row.verb} ${row.summary}`);
  }
  for (const row of hostexec) {
    add(row, "hostexec", `run ${row.command}`);
  }

  return [...bySession.values()].sort((a, b) => b.latestAt - a.latestAt);
}

export function filterPendingForSession<T extends { sessionId: string }>(
  rows: readonly T[],
  activeSessionId: string | null,
  showAllSessions: boolean,
): readonly T[] {
  if (showAllSessions || activeSessionId === null) return rows;
  return rows.filter((row) => row.sessionId === activeSessionId);
}
