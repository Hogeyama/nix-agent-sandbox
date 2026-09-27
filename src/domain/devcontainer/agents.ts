import type { AgentType } from "../../agents/types.ts";
import type { Profile } from "../../config/types.ts";

/** Agents that ship a VS Code / IDE extension inside the Dev Container. */
export type DevcontainerIdeAgent = "claude" | "codex";

/** Fixed order for the IDE agent set. */
const IDE_AGENT_ORDER: readonly DevcontainerIdeAgent[] = ["claude", "codex"];

/**
 * The set of IDE-capable agents a Dev Container session must configure and
 * prepare state for: the primary agent plus any of `extraAgents` that ship
 * an IDE extension (Copilot does not). Always returned in the fixed
 * `IDE_AGENT_ORDER`, independent of `extraAgents`' declaration order, so
 * configuration and state preparation remain deterministic.
 */
export function resolveDevcontainerIdeAgents(
  profile: Pick<Profile, "agent" | "extraAgents">,
): readonly DevcontainerIdeAgent[] {
  const present = new Set<AgentType>([profile.agent, ...profile.extraAgents]);
  return IDE_AGENT_ORDER.filter((agent) => present.has(agent));
}
