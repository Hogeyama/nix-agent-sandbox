/**
 * Pure helpers backing the agent ⇄ shell toggle in the terminals pane.
 *
 * The shell-session id grammar is owned by `src/ui/shell_session_id.ts`
 * and consumed by both the daemon and the Preact frontend; this module
 * imports the same parser so the agent ⇄ shell mapping stays consistent
 * across all three surfaces.
 */

import { parseShellSessionId } from "../../../shell_session_id";
import type { DtachSessionLike, SessionRow } from "./types";

export interface ShellEntry {
  sessionId: string;
  parentSessionId: string;
  seq: number;
}

/**
 * Resolves the agent row the terminal toolbar uses for its context block
 * and agent-scoped actions. Agent terminals map to their own row. Shell
 * terminals map to the parent agent row so the toolbar continues to show
 * the agent name/id while the shell session id stays active in the center
 * pane.
 */
export function resolveContextAgentRow(
  activeTerminalId: string | null,
  rows: readonly SessionRow[],
): SessionRow | null {
  if (activeTerminalId === null) return null;
  const contextAgentRow = rows.find((row) => row.id === activeTerminalId);
  if (contextAgentRow !== undefined) return contextAgentRow;
  const parsed = parseShellSessionId(activeTerminalId);
  if (parsed === null) return null;
  return rows.find((row) => row.id === parsed.parentSessionId) ?? null;
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
   * Label of the action triggered by the button.
   */
  label: string;
  disabled: boolean;
  currentBadge: "AGENT" | "SHELL";
}

/**
 * Describes the current state of the agent ⇄ shell toggle button. The
 * label names the action the click performs. While a spawn is in flight
 * the toggle is disabled to prevent a second request from racing the
 * first.
 *
 * The in-flight branch fixes currentBadge to AGENT because tryBeginShellSpawn
 * (App.tsx handleShellToggle) is reachable only on the agent → shell spawn
 * path: the shell-view branch returns before the spawn guard, and the
 * existing-shell branch attaches without spawning. While the spawn POST is
 * pending the user is still attached to the agent terminal, so the badge
 * stays AGENT.
 */
export function describeShellToggle(
  view: ShellView,
  inFlight: boolean,
): ShellToggleState {
  if (inFlight) {
    return { label: "Spawning…", disabled: true, currentBadge: "AGENT" };
  }
  if (view === "shell") {
    return {
      label: "Return to agent",
      disabled: false,
      currentBadge: "SHELL",
    };
  }
  return { label: "Open shell", disabled: false, currentBadge: "AGENT" };
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
