import type { PortCandidate, PortWatchState } from "../../api/client";

export type PortCandidateRow = {
  containerPort: number;
  /** Why a visible server would not answer, or null when it will. */
  hint: string | null;
};

/**
 * The relay dials 127.0.0.1, so a server bound to anything else is visible in
 * the container's socket table but unreachable through a binding. Saying which
 * address it picked is the whole value of showing it at all — otherwise the
 * user binds it, gets nothing, and has no way to tell why.
 */
export function candidateHint(candidate: PortCandidate): string | null {
  if (candidate.reachable) return null;
  if (candidate.scope === "loopback6") {
    return "Listening on ::1 only — restart it on 127.0.0.1 or 0.0.0.0 to bind it";
  }
  return "Listening on the container's external address only — restart it on 0.0.0.0 to bind it";
}

export function candidateRows(
  candidates: readonly PortCandidate[],
): PortCandidateRow[] {
  return [...candidates]
    .sort((a, b) => a.containerPort - b.containerPort)
    .map((candidate) => ({
      containerPort: candidate.containerPort,
      hint: candidateHint(candidate),
    }));
}

/**
 * What the panel says when the scan is on but has found nothing yet. An empty
 * list is the normal state, so it only earns a line when the reason is that
 * the scan could not run at all.
 */
export function watchNotice(watch: PortWatchState | null): string | null {
  if (watch === "container-not-running") return "Container is not running";
  if (watch === "relay-unreachable") return "Cannot reach the container";
  return null;
}
