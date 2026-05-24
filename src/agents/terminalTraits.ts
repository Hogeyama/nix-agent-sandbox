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
   * When true, the terminal forces xterm-side mouse-mode tracking on so the
   * pane can drive its own pseudo-scrollback. Copilot CLI relies on this
   * because it does not emit a DECSET mouse-tracking sequence itself, while
   * other agents declare any needed DECSET on their own and must not be
   * overridden.
   */
  readonly autoForceMouseMode: boolean;
}

/**
 * Resolve UI terminal traits for the given agent identifier.
 *
 * The lookup is a case-insensitive substring match: any agent string whose
 * lower-cased form contains `"copilot"` opts in to `autoForceMouseMode`.
 * Null, undefined, empty, and unrecognized identifiers map to an
 * all-defaults record with every trait disabled.
 */
export function getAgentTerminalTraits(
  agent: string | null | undefined,
): AgentTerminalTraits {
  if (agent === null || agent === undefined) {
    return { autoForceMouseMode: false };
  }
  const lower = agent.toLowerCase();
  if (lower.includes("copilot")) {
    return { autoForceMouseMode: true };
  }
  return { autoForceMouseMode: false };
}
