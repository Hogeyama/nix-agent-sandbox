/**
 * Pure helpers backing the agent ⇄ shell toggle in the terminals pane.
 *
 * The shell-session id grammar is owned by `src/ui/shell_session_id.ts`
 * and consumed by both the daemon and the Preact frontend; this module
 * imports the same parser so the agent ⇄ shell mapping stays consistent
 * across all three surfaces.
 */

import { parseShellSessionId } from "../../../shell_session_id";
import type { DtachSessionLike } from "./types";

export interface ShellEntry {
  sessionId: string;
  parentSessionId: string;
  seq: number;
}

/**
 * Returns the live shell with the highest `seq` parented to `agentId`,
 * or `null` when no shell exists. The daemon allows multiple shells per
 * container (it appends a fresh `seq` on every spawn), so the highest
 * seq wins on the client side as well: it is the most recently spawned
 * shell and therefore the one the user expects to see when toggling.
 */
export function findShellForAgent(
  agentId: string,
  dtachSessions: readonly DtachSessionLike[],
): ShellEntry | null {
  let best: ShellEntry | null = null;
  for (const s of dtachSessions) {
    const parsed = parseShellSessionId(s.sessionId);
    if (parsed === null) continue;
    if (parsed.parentSessionId !== agentId) continue;
    if (best === null || parsed.seq > best.seq) {
      best = {
        sessionId: s.sessionId,
        parentSessionId: parsed.parentSessionId,
        seq: parsed.seq,
      };
    }
  }
  return best;
}

export type ShellView = "agent" | "shell";

export interface ShellToggleState {
  /**
   * Label of the destination view: clicking the button switches to the
   * view named here. While a spawn request is in flight the label is
   * "Spawning…" and the button is disabled.
   */
  label: string;
  disabled: boolean;
}

/**
 * Describes the current state of the agent ⇄ shell toggle button. The
 * label is the destination view, i.e. the action the click performs:
 * "Shell" when currently viewing the agent, "Agent" when currently
 * viewing the shell. While a spawn is in flight the toggle is disabled
 * to prevent a second request from racing the first.
 */
export function describeShellToggle(
  view: ShellView,
  inFlight: boolean,
): ShellToggleState {
  if (inFlight) return { label: "Spawning…", disabled: true };
  if (view === "shell") return { label: "Agent", disabled: false };
  return { label: "Shell", disabled: false };
}

export interface ReconcileViewStateInput {
  prevView: Readonly<Record<string, ShellView>>;
  agentSessionIds: ReadonlySet<string>;
  dtachSessions: readonly DtachSessionLike[];
}

export interface ReconcileViewStateOutput {
  nextView: Record<string, ShellView>;
  /**
   * Agent ids whose `view === "shell"` entry has been forced back to
   * "agent" because their shell session is no longer in the dtach
   * snapshot. The caller uses this list to decide whether to switch
   * `activeId` away from the now-defunct shell id.
   */
  shellsExited: string[];
}

/**
 * Reconciles the per-session view map against the latest dtach snapshot.
 *
 *   - View entries for agents that are no longer alive are dropped so
 *     the map cannot grow unboundedly across stop/relaunch cycles.
 *   - "shell" entries whose backing shell session has exited revert to
 *     "agent" and are reported in `shellsExited`.
 *   - Snapshots that do not affect any tracked agent leave the map
 *     identity-stable (the caller may still receive a fresh object
 *     reference, but the entries are equal).
 */
export function reconcileViewState(
  input: ReconcileViewStateInput,
): ReconcileViewStateOutput {
  const next: Record<string, ShellView> = {};
  const shellsExited: string[] = [];
  for (const [agentId, view] of Object.entries(input.prevView)) {
    if (!input.agentSessionIds.has(agentId)) continue;
    if (
      view === "shell" &&
      findShellForAgent(agentId, input.dtachSessions) === null
    ) {
      next[agentId] = "agent";
      shellsExited.push(agentId);
      continue;
    }
    next[agentId] = view;
  }
  return { nextView: next, shellsExited };
}
