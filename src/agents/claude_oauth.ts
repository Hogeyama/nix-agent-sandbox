/**
 * Claude Code が `~/.claude/.credentials.json` に保存する OAuth credential の
 * 読み取りと組み立て。ファイル I/O は持たない。
 */

export const CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN =
  "nas-proxy-injected-access-token";
export const CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN =
  "nas-proxy-injected-refresh-token";
// Claude Code は期限が近いと自分で更新を始める。container 内で更新させない
// ために、ダミーの期限は十分遠くに置く (3000-01-01T00:00:00Z)。
export const CLAUDE_OAUTH_DUMMY_EXPIRES_AT = 32503680000000;

export interface ClaudeOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly clientId?: string;
}

export interface RefreshedClaudeTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly refreshTokenExpiresAt?: number;
}

export class ClaudeOAuthUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `[nas] Claude OAuth credentials are not available on the host (${detail}). ` +
        `Run "claude /login" on the host, or set agentState.auth = "shared" to keep sharing the credentials file (required for API key use).`,
    );
    this.name = "ClaudeOAuthUnavailableError";
  }
}

// ログイン状態の判定に使われる項目だけをダミーへ写す。未知の項目は秘密を
// 含みうるので写さない。
const DUMMY_OAUTH_FIELDS = ["scopes", "subscriptionType", "rateLimitTier"];
const DUMMY_TOP_LEVEL_FIELDS = ["organizationUuid"];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRoot(text: string): { root: JsonObject; oauth: JsonObject } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new ClaudeOAuthUnavailableError("the credentials file is not JSON");
  }
  if (!isObject(root) || !isObject(root.claudeAiOauth)) {
    throw new ClaudeOAuthUnavailableError("no claudeAiOauth entry");
  }
  return { root, oauth: root.claudeAiOauth };
}

function validateClaudeOAuthTokens(oauth: JsonObject): ClaudeOAuthTokens {
  const { accessToken, refreshToken, expiresAt, scopes, clientId } = oauth;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    typeof refreshToken !== "string" ||
    refreshToken === "" ||
    typeof expiresAt !== "number" ||
    !Array.isArray(scopes) ||
    !scopes.every((s) => typeof s === "string")
  ) {
    throw new ClaudeOAuthUnavailableError("the OAuth entry is incomplete");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: scopes as string[],
    ...(typeof clientId === "string" ? { clientId } : {}),
  };
}

export function parseClaudeOAuthTokens(text: string): ClaudeOAuthTokens {
  const { oauth } = parseRoot(text);
  return validateClaudeOAuthTokens(oauth);
}

export function buildDummyClaudeCredentials(hostText: string): string {
  const { root, oauth } = parseRoot(hostText);
  validateClaudeOAuthTokens(oauth);
  const dummyOAuth: JsonObject = {
    accessToken: CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN,
    refreshToken: CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN,
    expiresAt: CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
  };
  if ("refreshTokenExpiresAt" in oauth) {
    dummyOAuth.refreshTokenExpiresAt = CLAUDE_OAUTH_DUMMY_EXPIRES_AT;
  }
  for (const field of DUMMY_OAUTH_FIELDS) {
    if (field in oauth) dummyOAuth[field] = oauth[field];
  }
  const dummy: JsonObject = { claudeAiOauth: dummyOAuth };
  for (const field of DUMMY_TOP_LEVEL_FIELDS) {
    if (field in root) dummy[field] = root[field];
  }
  return `${JSON.stringify(dummy, null, 2)}\n`;
}

export function applyRefreshedTokens(
  hostText: string,
  tokens: RefreshedClaudeTokens,
): string {
  const { root, oauth } = parseRoot(hostText);
  const next: JsonObject = {
    ...root,
    claudeAiOauth: {
      ...oauth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt }
        : {}),
    },
  };
  return JSON.stringify(next);
}
