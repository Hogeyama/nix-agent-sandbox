import type { AgentCredentialsMode } from "../config/types.ts";
import type { AgentType } from "./types.ts";

/** ホスト側で認証情報を保持し proxy で注入する方式を実装済みのエージェントか。 */
export function supportsProxiedCredentials(agent: AgentType): boolean {
  return agent === "claude";
}

/**
 * `agentState.auth` の実効値を返す。未指定なら、実装済みのエージェントは
 * `"proxy"`、それ以外は `"shared"` になる。
 */
export function resolveAgentCredentials(
  agent: AgentType,
  configured: AgentCredentialsMode | undefined,
): AgentCredentialsMode {
  if (configured !== undefined) return configured;
  return supportsProxiedCredentials(agent) ? "proxy" : "shared";
}
