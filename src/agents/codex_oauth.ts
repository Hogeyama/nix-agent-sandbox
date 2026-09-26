/**
 * Codex CLI が `~/.codex/auth.json` に保存する ChatGPT の OAuth credential の
 * 読み取りと組み立て。ファイル I/O は持たない。
 *
 * Codex は id token と access token を JWT として読み (署名は検証しない)、
 * plan や account の情報を取り出す。ダミーにも JWT の形をした値が要るので、
 * 署名なしの JWT を作る。
 */

export const CODEX_DUMMY_REFRESH_TOKEN = "nas-proxy-injected-refresh-token";
export const CODEX_DUMMY_JWT_SIGNATURE = "nas-proxy-injected";
// Codex は access token の exp の5分前に自分で更新を始める。container 内で
// 更新させないために、ダミーの期限は十分遠くに置く (3000-01-01T00:00:00Z、秒)。
export const CODEX_DUMMY_ACCESS_TOKEN_EXP = 32503680000;
// Codex は期限を読めない access token を、最後の更新から8日で更新する。
const TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60_000;

const AUTH_CLAIMS = "https://api.openai.com/auth";
const PROFILE_CLAIMS = "https://api.openai.com/profile";
// Codex が plan の表示や workspace の判定に使う claim だけをダミーへ写す。
// 未知の claim は秘密や不要な個人情報を含みうるので写さない。
const ID_TOKEN_AUTH_CLAIMS = [
  "chatgpt_plan_type",
  "chatgpt_user_id",
  "user_id",
  "chatgpt_account_id",
  "chatgpt_account_user_id",
  "chatgpt_account_is_fedramp",
];
const ACCESS_TOKEN_AUTH_CLAIMS = [
  "chatgpt_account_id",
  "chatgpt_account_user_id",
];

export interface CodexOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** access token の期限 (ms)。 */
  readonly expiresAt: number;
  /** `chatgpt-account-id` header に付ける値。 */
  readonly accountId: string | null;
  /** access token の `client_id` claim。refresh の request に使う。 */
  readonly clientId?: string;
}

export interface RefreshedCodexTokens {
  readonly accessToken: string;
  /** 省略されたら元の refresh token を使い続ける。 */
  readonly refreshToken?: string;
  readonly idToken?: string;
  /** 更新した時刻 (ms)。ファイルの `last_refresh` になる。 */
  readonly refreshedAt: number;
}

export class CodexOAuthUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `[nas] Codex ChatGPT credentials are not available in the host ~/.codex/auth.json (${detail}). ` +
        `Run "codex login" on the host, or set agentState.auth = "passthrough" (or new Mapping { ["codex"] = "passthrough" } for Codex only; required for API key use and for credentials stored in the keyring).`,
    );
    this.name = "CodexOAuthUnavailableError";
  }
}

/**
 * host の auth.json を読んだときのエラーを、呼び出し元が投げるエラーに
 * 変換する。file か `~/.codex` が無いときは、未ログインかキーリングに保存
 * しているとみなして案内する。それ以外は原因を隠さないよう元のエラーを返す。
 */
export function codexCredentialsReadError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new CodexOAuthUnavailableError("no auth.json");
  }
  return error;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JWT の payload を読む。Codex と同じく署名は検証しない。読めなければ null。 */
export function decodeJwtPayload(jwt: string): JsonObject | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    );
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

function encodeUnsignedJwt(payload: JsonObject): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.${CODEX_DUMMY_JWT_SIGNATURE}`;
}

function pickFields(
  source: unknown,
  fields: readonly string[],
): JsonObject | undefined {
  if (!isObject(source)) return undefined;
  const picked: JsonObject = {};
  for (const field of fields) {
    if (field in source) picked[field] = source[field];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function stringField(source: unknown, field: string): string | undefined {
  if (!isObject(source)) return undefined;
  const value = source[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function accessTokenExpiry(
  claims: JsonObject | null,
  lastRefreshMs: number | undefined,
): number {
  if (typeof claims?.exp === "number") return claims.exp * 1000;
  if (lastRefreshMs !== undefined) {
    return lastRefreshMs + TOKEN_REFRESH_INTERVAL_MS;
  }
  // 期限の手がかりが無ければ、すぐに更新して期限の読める token を得る。
  return 0;
}

function parseRoot(text: string): { root: JsonObject; tokens: JsonObject } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new CodexOAuthUnavailableError("auth.json is not JSON");
  }
  if (!isObject(root)) {
    throw new CodexOAuthUnavailableError("auth.json is not an object");
  }
  const mode = root.auth_mode;
  if (mode !== undefined && mode !== null && mode !== "chatgpt") {
    throw new CodexOAuthUnavailableError(
      `auth_mode is ${JSON.stringify(mode)}, not a ChatGPT login`,
    );
  }
  if (
    (mode === undefined || mode === null) &&
    typeof root.OPENAI_API_KEY === "string" &&
    root.OPENAI_API_KEY !== ""
  ) {
    throw new CodexOAuthUnavailableError(
      "an API key is stored instead of a ChatGPT login",
    );
  }
  if (!isObject(root.tokens)) {
    throw new CodexOAuthUnavailableError("no tokens entry");
  }
  return { root, tokens: root.tokens };
}

function validateTokens(
  root: JsonObject,
  tokens: JsonObject,
): CodexOAuthTokens {
  const accessToken = stringField(tokens, "access_token");
  const refreshToken = stringField(tokens, "refresh_token");
  const idToken = stringField(tokens, "id_token");
  if (!accessToken || !refreshToken || !idToken) {
    throw new CodexOAuthUnavailableError("the tokens entry is incomplete");
  }
  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = decodeJwtPayload(idToken);
  const accountId =
    stringField(tokens, "account_id") ??
    stringField(idClaims?.[AUTH_CLAIMS], "chatgpt_account_id") ??
    null;
  const clientId = stringField(accessClaims, "client_id");
  const lastRefresh =
    typeof root.last_refresh === "string"
      ? Date.parse(root.last_refresh)
      : Number.NaN;
  return {
    accessToken,
    refreshToken,
    expiresAt: accessTokenExpiry(
      accessClaims,
      Number.isNaN(lastRefresh) ? undefined : lastRefresh,
    ),
    accountId,
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

export function parseCodexOAuthTokens(text: string): CodexOAuthTokens {
  const { root, tokens } = parseRoot(text);
  return validateTokens(root, tokens);
}

export function buildDummyCodexAuth(hostText: string, now: number): string {
  const { root, tokens } = parseRoot(hostText);
  const parsed = validateTokens(root, tokens);
  const idClaims = decodeJwtPayload(tokens.id_token as string);
  const accessClaims = decodeJwtPayload(tokens.access_token as string);

  const idPayload: JsonObject = {};
  const email = stringField(idClaims, "email");
  if (email !== undefined) idPayload.email = email;
  const profile = pickFields(idClaims?.[PROFILE_CLAIMS], ["email"]);
  if (profile !== undefined) idPayload[PROFILE_CLAIMS] = profile;
  const idAuth = pickFields(idClaims?.[AUTH_CLAIMS], ID_TOKEN_AUTH_CLAIMS);
  if (idAuth !== undefined) idPayload[AUTH_CLAIMS] = idAuth;

  const accessPayload: JsonObject = { exp: CODEX_DUMMY_ACCESS_TOKEN_EXP };
  const accessAuth = pickFields(
    accessClaims?.[AUTH_CLAIMS],
    ACCESS_TOKEN_AUTH_CLAIMS,
  );
  if (accessAuth !== undefined) accessPayload[AUTH_CLAIMS] = accessAuth;

  const dummy = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: encodeUnsignedJwt(idPayload),
      access_token: encodeUnsignedJwt(accessPayload),
      refresh_token: CODEX_DUMMY_REFRESH_TOKEN,
      account_id: parsed.accountId,
    },
    last_refresh: new Date(now).toISOString(),
  };
  return `${JSON.stringify(dummy, null, 2)}\n`;
}

export function mergeRefreshedCodexTokens(
  tokens: CodexOAuthTokens,
  refreshed: RefreshedCodexTokens,
): CodexOAuthTokens {
  return {
    ...tokens,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    expiresAt: accessTokenExpiry(
      decodeJwtPayload(refreshed.accessToken),
      refreshed.refreshedAt,
    ),
  };
}

export function applyRefreshedCodexTokens(
  hostText: string,
  refreshed: RefreshedCodexTokens,
): string {
  const { root, tokens } = parseRoot(hostText);
  const next: JsonObject = {
    ...root,
    tokens: {
      ...tokens,
      access_token: refreshed.accessToken,
      ...(refreshed.refreshToken !== undefined
        ? { refresh_token: refreshed.refreshToken }
        : {}),
      ...(refreshed.idToken !== undefined
        ? { id_token: refreshed.idToken }
        : {}),
    },
    last_refresh: new Date(refreshed.refreshedAt).toISOString(),
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}
