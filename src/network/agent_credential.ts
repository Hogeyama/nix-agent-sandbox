/**
 * 許可した request に、ホストが保持するエージェントの credential を注入する。
 *
 * エージェントが付けた credential を上流へ届けないために、注入先のホストでは
 * Authorization を必ずホストの値で上書きし、x-api-key は削除する。利用者の
 * 設定が同じ header を注入していても、こちらが優先する。
 */

import type { DecisionResponse, InjectHeader } from "./protocol.ts";

export const CREDENTIAL_REFRESH_DENY_REASON =
  "credential-refresh-owned-by-host";

const CREDENTIAL_HOSTS = new Set([
  "api.anthropic.com",
  "mcp-proxy.anthropic.com",
]);
const REMOVED_HEADERS = ["x-api-key"];

/**
 * container からの token 更新か。container が持つ refresh token はダミー値で
 * あり、更新はホストが行う。
 */
export function isHostOwnedCredentialRefresh(
  host: string,
  method: string,
  path: string | undefined,
): boolean {
  if (host !== "platform.claude.com" || method.toUpperCase() !== "POST") {
    return false;
  }
  if (path === undefined) return false;
  return path.split("?")[0] === "/v1/oauth/token";
}

export function applyAgentCredential(
  decision: DecisionResponse,
  host: string,
  accessToken: string,
): DecisionResponse {
  if (decision.decision !== "allow" || !CREDENTIAL_HOSTS.has(host)) {
    return decision;
  }
  const injectHeaders: InjectHeader[] = [
    ...(decision.injectHeaders ?? []).filter(
      (header) => header.name.toLowerCase() !== "authorization",
    ),
    { name: "Authorization", value: `Bearer ${accessToken}` },
  ];
  return { ...decision, injectHeaders, removeHeaders: [...REMOVED_HEADERS] };
}
