/**
 * 許可した request に、ホストが保持するエージェントの credential を注入する。
 *
 * エージェントが付けた credential を上流へ届けないために、注入先のホストでは
 * 認証の header を必ずホストの値で上書きし、エージェントごとに決めた header
 * を削除する。利用者の設定が同じ header を注入していても、こちらが優先する。
 * container からの token 更新は、container が持つ refresh token がダミー値
 * なので、評価より前に拒否する。
 */

import type { DecisionResponse, InjectHeader } from "./protocol.ts";

export const CREDENTIAL_REFRESH_DENY_REASON =
  "credential-refresh-owned-by-host";
/** ホストの credential が使えなくなった後の、注入先への request。 */
export const CREDENTIAL_REVOKED_DENY_REASON = "credential-revoked-on-host";

export interface AgentCredential {
  /** 注入先のホスト。 */
  readonly injectHosts: readonly string[];
  /** 注入先で request から削除する header。 */
  readonly removeHeaders: readonly string[];
  /** container からの token 更新か。 */
  isHostOwnedRefresh(
    host: string,
    method: string,
    path: string | undefined,
  ): boolean;
  /** 注入する header。ホストの credential が使えなくなったら null。 */
  headers(): readonly InjectHeader[] | null;
  close(): Promise<void>;
}

function isPostTo(
  host: string,
  method: string,
  path: string | undefined,
  expectedHost: string,
  expectedPath: string,
): boolean {
  if (host !== expectedHost || method.toUpperCase() !== "POST") return false;
  if (path === undefined) return false;
  return path.split("?")[0] === expectedPath;
}

export function claudeAgentCredential(source: {
  current(): string;
  close(): Promise<void>;
}): AgentCredential {
  return {
    injectHosts: ["api.anthropic.com", "mcp-proxy.anthropic.com"],
    removeHeaders: ["x-api-key"],
    isHostOwnedRefresh: (host, method, path) =>
      isPostTo(host, method, path, "platform.claude.com", "/v1/oauth/token"),
    headers: () => [
      { name: "Authorization", value: `Bearer ${source.current()}` },
    ],
    close: () => source.close(),
  };
}

/**
 * `chatgpt-account-id` も上書きする。container の値はダミーファイルからの
 * もので同じ値になるが、ホストの token と異なる account を指定させない。
 */
export function codexAgentCredential(source: {
  current(): { accessToken: string; accountId: string | null } | null;
  close(): Promise<void>;
}): AgentCredential {
  return {
    injectHosts: ["chatgpt.com"],
    removeHeaders: [],
    isHostOwnedRefresh: (host, method, path) =>
      isPostTo(host, method, path, "auth.openai.com", "/oauth/token"),
    headers: () => {
      const credential = source.current();
      if (credential === null) return null;
      return [
        { name: "Authorization", value: `Bearer ${credential.accessToken}` },
        ...(credential.accountId !== null
          ? [{ name: "chatgpt-account-id", value: credential.accountId }]
          : []),
      ];
    },
    close: () => source.close(),
  };
}

function credentialForHost(
  credentials: readonly AgentCredential[],
  host: string,
): AgentCredential | undefined {
  return credentials.find((credential) =>
    credential.injectHosts.includes(host),
  );
}

export function isHostOwnedCredentialRefresh(
  credentials: readonly AgentCredential[],
  host: string,
  method: string,
  path: string | undefined,
): boolean {
  return credentials.some((credential) =>
    credential.isHostOwnedRefresh(host, method, path),
  );
}

export function isRevokedCredentialHost(
  credentials: readonly AgentCredential[],
  host: string,
): boolean {
  const credential = credentialForHost(credentials, host);
  return credential !== undefined && credential.headers() === null;
}

export function applyAgentCredentials(
  decision: DecisionResponse,
  host: string,
  credentials: readonly AgentCredential[],
): DecisionResponse {
  if (decision.decision !== "allow") return decision;
  const credential = credentialForHost(credentials, host);
  if (credential === undefined) return decision;
  const headers = credential.headers();
  // 使えなくなった credential の注入先は評価より前に拒否している。
  if (headers === null) return decision;
  const overridden = new Set(headers.map((h) => h.name.toLowerCase()));
  const injectHeaders: InjectHeader[] = [
    ...(decision.injectHeaders ?? []).filter(
      (header) => !overridden.has(header.name.toLowerCase()),
    ),
    ...headers,
  ];
  return {
    ...decision,
    injectHeaders,
    ...(credential.removeHeaders.length > 0
      ? { removeHeaders: [...credential.removeHeaders] }
      : {}),
  };
}
