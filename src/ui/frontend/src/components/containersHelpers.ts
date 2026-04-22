import type { ContainerInfo } from "../api.ts";

/**
 * Format an ISO timestamp as a relative duration from `now`.
 *
 * @param iso ISO-8601 timestamp string.
 * @param now Reference epoch milliseconds. Defaults to `Date.now()`.
 *   This parameter exists for test injection; production call sites
 *   should rely on the default.
 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const ms = now - new Date(iso).getTime();
  if (ms < 0 || Number.isNaN(ms)) return "-";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}min ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h ago`;
}

export function isAckEligibleTurn(turn: ContainerInfo["turn"]): boolean {
  return turn === "user-turn" || turn === "ack-turn";
}

export function startedTimestamp(c: ContainerInfo): number {
  const iso = c.sessionStartedAt ?? c.startedAt;
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

export function sortContainers(items: ContainerInfo[]): ContainerInfo[] {
  return [...items].sort((a, b) => {
    // Most-recently-started first.
    return startedTimestamp(b) - startedTimestamp(a);
  });
}
