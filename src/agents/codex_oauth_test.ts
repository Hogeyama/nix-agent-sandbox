import { expect, test } from "bun:test";
import {
  applyRefreshedCodexTokens,
  buildDummyCodexAuth,
  CODEX_DUMMY_ACCESS_TOKEN_EXP,
  CODEX_DUMMY_JWT_SIGNATURE,
  CODEX_DUMMY_REFRESH_TOKEN,
  CodexOAuthUnavailableError,
  codexCredentialsReadError,
  decodeJwtPayload,
  mergeRefreshedCodexTokens,
  parseCodexOAuthTokens,
} from "./codex_oauth.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.real-signature`;
}

const AUTH = "https://api.openai.com/auth";
const PROFILE = "https://api.openai.com/profile";

const HOST_ID_TOKEN = jwt({
  email: "me@example.com",
  sub: "secret-subject",
  [AUTH]: {
    chatgpt_plan_type: "pro",
    chatgpt_user_id: "user-1",
    user_id: "user-1",
    chatgpt_account_id: "acct-1",
    chatgpt_account_is_fedramp: false,
    organizations: [{ id: "org-secret" }],
  },
});
const HOST_ACCESS_TOKEN = jwt({
  exp: 1_800_000_000,
  client_id: "app_custom",
  [AUTH]: {
    chatgpt_account_id: "acct-1",
    chatgpt_account_user_id: "acct-user-1",
    chatgpt_plan_type: "pro",
  },
  [PROFILE]: { email: "me@example.com" },
});

function hostAuth(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: HOST_ID_TOKEN,
      access_token: HOST_ACCESS_TOKEN,
      refresh_token: "real-refresh",
      account_id: "acct-1",
    },
    last_refresh: "2026-09-19T14:20:05.692Z",
    extra_field: "kept-on-host",
    ...overrides,
  });
}

test("parseCodexOAuthTokens: reads tokens, expiry, account and client id", () => {
  expect(parseCodexOAuthTokens(hostAuth())).toEqual({
    accessToken: HOST_ACCESS_TOKEN,
    refreshToken: "real-refresh",
    expiresAt: 1_800_000_000_000,
    accountId: "acct-1",
    clientId: "app_custom",
  });
});

test("parseCodexOAuthTokens: falls back to the id token account and last_refresh + 8 days", () => {
  const access = jwt({ [AUTH]: {} });
  const text = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: HOST_ID_TOKEN,
      access_token: access,
      refresh_token: "r",
    },
    last_refresh: "2026-09-01T00:00:00.000Z",
  });
  const tokens = parseCodexOAuthTokens(text);
  expect(tokens.accountId).toBe("acct-1");
  expect(tokens.expiresAt).toBe(
    Date.parse("2026-09-01T00:00:00.000Z") + 8 * 24 * 60 * 60_000,
  );
  expect(tokens.clientId).toBeUndefined();
});

test("parseCodexOAuthTokens: rejects API key logins and incomplete files", () => {
  for (const text of [
    "not json",
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }),
    JSON.stringify({ OPENAI_API_KEY: "sk-x" }),
    JSON.stringify({ auth_mode: "chatgpt" }),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: HOST_ID_TOKEN, access_token: "", refresh_token: "r" },
    }),
  ]) {
    expect(() => parseCodexOAuthTokens(text)).toThrow(
      CodexOAuthUnavailableError,
    );
  }
});

test("codexCredentialsReadError: a missing file asks for codex login", () => {
  const missing = Object.assign(new Error("nope"), { code: "ENOENT" });
  const converted = codexCredentialsReadError(missing);
  expect(converted).toBeInstanceOf(CodexOAuthUnavailableError);
  expect(String(converted)).toContain("codex login");
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  expect(codexCredentialsReadError(denied)).toBe(denied);
});

test("buildDummyCodexAuth: keeps no real token and only the listed claims", () => {
  const now = Date.parse("2026-09-24T00:00:00.000Z");
  const dummyText = buildDummyCodexAuth(hostAuth(), now);
  expect(dummyText).not.toContain("real-refresh");
  expect(dummyText).not.toContain("real-signature");
  expect(dummyText).not.toContain("secret-subject");
  expect(dummyText).not.toContain("org-secret");
  expect(dummyText).not.toContain("kept-on-host");

  const dummy = JSON.parse(dummyText);
  expect(dummy.auth_mode).toBe("chatgpt");
  expect(dummy.OPENAI_API_KEY).toBeNull();
  expect(dummy.last_refresh).toBe("2026-09-24T00:00:00.000Z");
  expect(dummy.tokens.refresh_token).toBe(CODEX_DUMMY_REFRESH_TOKEN);
  expect(dummy.tokens.account_id).toBe("acct-1");

  for (const token of [dummy.tokens.id_token, dummy.tokens.access_token]) {
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe(CODEX_DUMMY_JWT_SIGNATURE);
  }
  expect(decodeJwtPayload(dummy.tokens.id_token)).toEqual({
    email: "me@example.com",
    [AUTH]: {
      chatgpt_plan_type: "pro",
      chatgpt_user_id: "user-1",
      user_id: "user-1",
      chatgpt_account_id: "acct-1",
      chatgpt_account_is_fedramp: false,
    },
  });
  expect(decodeJwtPayload(dummy.tokens.access_token)).toEqual({
    exp: CODEX_DUMMY_ACCESS_TOKEN_EXP,
    [AUTH]: {
      chatgpt_account_id: "acct-1",
      chatgpt_account_user_id: "acct-user-1",
    },
  });
});

test("buildDummyCodexAuth: rejects a host file without a ChatGPT login", () => {
  expect(() =>
    buildDummyCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x" }), 0),
  ).toThrow(CodexOAuthUnavailableError);
});

test("mergeRefreshedCodexTokens: takes the new expiry and keeps an omitted refresh token", () => {
  const tokens = parseCodexOAuthTokens(hostAuth());
  const access = jwt({ exp: 1_900_000_000 });
  expect(
    mergeRefreshedCodexTokens(tokens, {
      accessToken: access,
      refreshedAt: 0,
    }),
  ).toEqual({
    ...tokens,
    accessToken: access,
    expiresAt: 1_900_000_000_000,
  });
});

test("applyRefreshedCodexTokens: replaces only the refreshed tokens and last_refresh", () => {
  const access = jwt({ exp: 1_900_000_000 });
  const next = JSON.parse(
    applyRefreshedCodexTokens(hostAuth(), {
      accessToken: access,
      refreshToken: "refresh-2",
      idToken: "id-2",
      refreshedAt: Date.parse("2026-09-24T00:00:00.000Z"),
    }),
  );
  expect(next.tokens).toEqual({
    id_token: "id-2",
    access_token: access,
    refresh_token: "refresh-2",
    account_id: "acct-1",
  });
  expect(next.last_refresh).toBe("2026-09-24T00:00:00.000Z");
  expect(next.extra_field).toBe("kept-on-host");
  expect(next.auth_mode).toBe("chatgpt");
});
