/**
 * Browser-safe terminal trait declarations for agent UI integration.
 *
 * This module intentionally has no imports. Frontend code may import it
 * directly without pulling server-only agent implementations into the bundle.
 *
 * Traits drive UI-layer terminal behavior so callers do not branch on agent
 * identifiers. The UI consumes a small, declarative record per agent string
 * instead of scattering `agent === "copilot"` checks across components.
 */

/**
 * UI-facing terminal behavior knobs for a session's agent.
 *
 * Each field describes a capability the terminal layer should enable when
 * rendering the agent's pseudo-terminal output.
 */
export interface AgentTerminalTraits {
  /**
   * When true, the terminal forces xterm-side mouse-mode tracking on.
   * Copilot CLI relies on this because it does not emit a DECSET
   * mouse-tracking sequence itself. Claude Code does emit DECSET, but only
   * once at startup — dtach does not replay terminal modes on re-attach, so
   * a UI terminal attaching later never sees the sequence and must force
   * mouse mode itself. Sessions left false get an explicit mouse-mode reset
   * after attach to keep normal text selection working.
   */
  readonly autoForceMouseMode: boolean;
}

/**
 * Resolve UI terminal traits for the given agent identifier.
 *
 * The lookup is a case-insensitive substring match: any agent string whose
 * lower-cased form contains `"copilot"` or `"claude"` opts in to
 * `autoForceMouseMode`. Null, undefined, empty, and unrecognized
 * identifiers map to an all-defaults record with every trait disabled.
 */
export function getAgentTerminalTraits(
  agent: string | null | undefined,
): AgentTerminalTraits {
  if (agent === null || agent === undefined) {
    return { autoForceMouseMode: false };
  }
  const lower = agent.toLowerCase();
  if (lower.includes("copilot") || lower.includes("claude")) {
    return { autoForceMouseMode: true };
  }
  return { autoForceMouseMode: false };
}
