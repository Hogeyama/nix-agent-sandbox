import { expect, test } from "bun:test";
import {
  applyRefreshedTokens,
  buildDummyClaudeCredentials,
  CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN,
  CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
  CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN,
  ClaudeOAuthUnavailableError,
  claudeCredentialsReadError,
  parseClaudeOAuthTokens,
} from "./claude_oauth.ts";

const HOST = JSON.stringify({
  claudeAiOauth: {
    accessToken: "real-access",
    refreshToken: "real-refresh",
    expiresAt: 1000,
    refreshTokenExpiresAt: 2000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    unknownSecret: "must-not-be-copied",
  },
  organizationUuid: "org-1",
  otherTopLevel: "must-not-be-copied",
});

test("parseClaudeOAuthTokens: reads the OAuth tokens", () => {
  expect(parseClaudeOAuthTokens(HOST)).toEqual({
    accessToken: "real-access",
    refreshToken: "real-refresh",
    expiresAt: 1000,
    scopes: ["user:inference", "user:profile"],
  });
});

test("parseClaudeOAuthTokens: keeps clientId when present", () => {
  const text = JSON.stringify({
    claudeAiOauth: {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
      scopes: [],
      clientId: "client-x",
    },
  });
  expect(parseClaudeOAuthTokens(text).clientId).toBe("client-x");
});

test("parseClaudeOAuthTokens: rejects files without OAuth tokens", () => {
  for (const text of [
    "{}",
    "not json",
    "[]",
    "42",
    "null",
    JSON.stringify({ claudeAiOauth: { accessToken: "a" } }),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: "soon",
        scopes: [],
      },
    }),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "",
        refreshToken: "r",
        expiresAt: 1,
        scopes: [],
      },
    }),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "",
        expiresAt: 1,
        scopes: [],
      },
    }),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
        scopes: "user:inference",
      },
    }),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
        scopes: ["ok", 1],
      },
    }),
  ]) {
    expect(() => parseClaudeOAuthTokens(text)).toThrow(
      ClaudeOAuthUnavailableError,
    );
  }
});

test("buildDummyClaudeCredentials: replaces secrets and copies only known fields", () => {
  const dummy = JSON.parse(buildDummyClaudeCredentials(HOST));
  expect(dummy).toEqual({
    claudeAiOauth: {
      accessToken: CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN,
      refreshToken: CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN,
      expiresAt: CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
      refreshTokenExpiresAt: CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
    organizationUuid: "org-1",
  });
  expect(JSON.stringify(dummy)).not.toContain("real-");
});

test("buildDummyClaudeCredentials: copies MCP server OAuth tokens but not the IdP token", () => {
  // Claude Code は MCP サーバーの OAuth token を同じファイルに置く。写さないと
  // container で OAuth の MCP サーバーが未認証になる。
  const mcpOAuth = {
    "notion|abc123": {
      serverName: "notion",
      serverUrl: "https://mcp.notion.com/mcp",
      accessToken: "mcp-access",
      refreshToken: "mcp-refresh",
      expiresAt: 3000,
    },
  };
  const mcpOAuthClientConfig = {
    "notion|abc123": { clientSecret: "mcp-client-secret" },
  };
  const host = JSON.stringify({
    ...JSON.parse(HOST),
    mcpOAuth,
    mcpOAuthClientConfig,
    mcpXaaIdp: { idToken: "idp-token" },
    trustedDeviceToken: "device-token",
  });
  const dummy = JSON.parse(buildDummyClaudeCredentials(host));
  expect(dummy.mcpOAuth).toEqual(mcpOAuth);
  expect(dummy.mcpOAuthClientConfig).toEqual(mcpOAuthClientConfig);
  expect(dummy.mcpXaaIdp).toBeUndefined();
  expect(dummy.trustedDeviceToken).toBeUndefined();
  expect(JSON.stringify(dummy)).not.toContain("real-");
});

test("buildDummyClaudeCredentials: omits optional fields when the host file lacks them", () => {
  const minimalHost = JSON.stringify({
    claudeAiOauth: {
      accessToken: "real-access",
      refreshToken: "real-refresh",
      expiresAt: 1000,
      scopes: ["user:inference"],
    },
  });
  const dummy = JSON.parse(buildDummyClaudeCredentials(minimalHost));
  expect(dummy).toEqual({
    claudeAiOauth: {
      accessToken: CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN,
      refreshToken: CLAUDE_OAUTH_DUMMY_REFRESH_TOKEN,
      expiresAt: CLAUDE_OAUTH_DUMMY_EXPIRES_AT,
      scopes: ["user:inference"],
    },
  });
});

test("buildDummyClaudeCredentials: fails when the host file has no OAuth tokens", () => {
  expect(() => buildDummyClaudeCredentials("{}")).toThrow(
    ClaudeOAuthUnavailableError,
  );
});

test("applyRefreshedTokens: replaces only the token fields", () => {
  const next = JSON.parse(
    applyRefreshedTokens(HOST, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 5000,
      refreshTokenExpiresAt: 9000,
    }),
  );
  expect(next.claudeAiOauth.accessToken).toBe("new-access");
  expect(next.claudeAiOauth.refreshToken).toBe("new-refresh");
  expect(next.claudeAiOauth.expiresAt).toBe(5000);
  expect(next.claudeAiOauth.refreshTokenExpiresAt).toBe(9000);
  expect(next.claudeAiOauth.unknownSecret).toBe("must-not-be-copied");
  expect(next.otherTopLevel).toBe("must-not-be-copied");
});

test("applyRefreshedTokens: keeps refreshTokenExpiresAt when the response omits it", () => {
  const next = JSON.parse(
    applyRefreshedTokens(HOST, {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
    }),
  );
  expect(next.claudeAiOauth.refreshTokenExpiresAt).toBe(2000);
});

test("applyRefreshedTokens: rejects a host file without OAuth tokens", () => {
  const tokens = {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: 1,
  };
  expect(() => applyRefreshedTokens("not json", tokens)).toThrow(
    ClaudeOAuthUnavailableError,
  );
  expect(() => applyRefreshedTokens("{}", tokens)).toThrow(
    ClaudeOAuthUnavailableError,
  );
});

test("claudeCredentialsReadError: maps ENOENT and ENOTDIR to the login guidance", () => {
  for (const code of ["ENOENT", "ENOTDIR"]) {
    const error = Object.assign(new Error(code), { code });
    expect(claudeCredentialsReadError(error)).toBeInstanceOf(
      ClaudeOAuthUnavailableError,
    );
  }
});

test("ClaudeOAuthUnavailableError: mentions both the string and per-agent Mapping opt-out", () => {
  const message = new ClaudeOAuthUnavailableError("no credentials file")
    .message;
  expect(message).toContain('agentState.auth = "shared"');
  expect(message).toContain('new Mapping { ["claude"] = "shared" }');
});

test("claudeCredentialsReadError: returns other errors unchanged", () => {
  const eacces = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  expect(claudeCredentialsReadError(eacces)).toBe(eacces);
  const plain = new Error("boom");
  expect(claudeCredentialsReadError(plain)).toBe(plain);
});
