import type {
  AgentCredentialsConfig,
  AgentCredentialsMode,
  Profile,
} from "../config/types.ts";
import type { AgentType } from "./types.ts";

/** 起動するか extraAgents に含むかを問わず、コンテナに Claude を用意するか */
export function usesClaude(
  profile: Pick<Profile, "agent" | "extraAgents">,
): boolean {
  return profile.agent === "claude" || profile.extraAgents.includes("claude");
}

/** `agentState.auth` の解決に要る、セッションの種類。 */
export interface CredentialsContext {
  /**
   * Dev Container のセッションか。Dev Container の Codex は VS Code 拡張機能が
   * 起動し、`~/.codex` の扱いが異なるので、proxy の対象にしない。
   */
  readonly devcontainer?: boolean;
}

export type CredentialsProfile = Pick<Profile, "agent" | "agentState"> & {
  readonly extraAgents?: readonly AgentType[];
};

/** ホスト側で認証情報を保持し proxy で注入する方式を実装済みのエージェントか。 */
export function supportsProxiedCredentials(agent: AgentType): boolean {
  return agent === "claude" || agent === "codex";
}

/**
 * `agentState.auth` がエージェントに明示している値を返す。文字列はすべての
 * エージェントに、Mapping は書いたエージェントにだけ当てはまる。
 */
export function configuredAgentCredentials(
  auth: AgentCredentialsConfig | undefined,
  agent: AgentType,
): AgentCredentialsMode | undefined {
  if (auth === undefined || typeof auth === "string") return auth;
  return auth[agent];
}

/**
 * エージェントの `agentState.auth` の実効値を返す。
 *
 * 未実装のエージェントは、明示されていても `"passthrough"` になる。Copilot の
 * token は `~/.copilot` に無いので、共有しても保護は弱まらない。未指定なら
 * 実装済みのエージェントは `"injected"` になる。ただし Dev Container の Codex は
 * `"passthrough"` になる。
 */
export function resolveAgentCredentials(
  agent: AgentType,
  auth: AgentCredentialsConfig | undefined,
  context: CredentialsContext = {},
): AgentCredentialsMode {
  if (!supportsProxiedCredentials(agent)) return "passthrough";
  const configured = configuredAgentCredentials(auth, agent);
  if (configured !== undefined) return configured;
  if (agent === "codex" && context.devcontainer) return "passthrough";
  return "injected";
}

/**
 * コンテナに用意する agent を、ホストが保持する credential を proxy で
 * 注入する方式で動かすかを返す。起動するエージェントと extraAgents の
 * どちらに含まれていてもよい。
 */
export function usesProxiedCredentials(
  profile: CredentialsProfile,
  agent: AgentType,
  context: CredentialsContext = {},
): boolean {
  const provisioned =
    profile.agent === agent || (profile.extraAgents ?? []).includes(agent);
  return (
    provisioned &&
    resolveAgentCredentials(agent, profile.agentState.auth, context) ===
      "injected"
  );
}

export function usesProxiedClaudeCredentials(
  profile: CredentialsProfile,
): boolean {
  return usesProxiedCredentials(profile, "claude");
}

export function usesProxiedCodexCredentials(
  profile: CredentialsProfile,
  context: CredentialsContext = {},
): boolean {
  return usesProxiedCredentials(profile, "codex", context);
}
