import { expect, test } from "bun:test";
import {
  type AgentCredential,
  applyAgentCredentials,
  claudeAgentCredential,
  codexAgentCredential,
  isHostOwnedCredentialRefresh,
  isRevokedCredentialTarget,
} from "./agent_credential.ts";
import type { DecisionResponse } from "./protocol.ts";

function allow(extra: Partial<DecisionResponse> = {}): DecisionResponse {
  return {
    version: 1,
    type: "decision",
    requestId: "r1",
    decision: "allow",
    reason: "allowed",
    ...extra,
  };
}

const claude = claudeAgentCredential({
  current: () => "tok",
  close: async () => {},
});

function codex(
  current: { accessToken: string; accountId: string | null } | null = {
    accessToken: "ctok",
    accountId: "acct-1",
  },
): AgentCredential {
  return codexAgentCredential({
    current: () => current,
    close: async () => {},
  });
}

test("applyAgentCredentials: injects the bearer token and removes x-api-key for Anthropic hosts", () => {
  for (const host of ["api.anthropic.com", "mcp-proxy.anthropic.com"]) {
    expect(
      applyAgentCredentials(allow(), host, "/v1/messages", [claude]),
    ).toEqual(
      allow({
        injectHeaders: [{ name: "Authorization", value: "Bearer tok" }],
        removeHeaders: ["x-api-key"],
      }),
    );
  }
});

test("applyAgentCredentials: replaces a user-configured Authorization inject of any case", () => {
  const result = applyAgentCredentials(
    allow({
      injectHeaders: [
        { name: "authorization", value: "user" },
        { name: "x-extra", value: "kept" },
      ],
    }),
    "api.anthropic.com",
    "/v1/messages",
    [claude],
  );
  expect(result.injectHeaders).toEqual([
    { name: "x-extra", value: "kept" },
    { name: "Authorization", value: "Bearer tok" },
  ]);
});

test("applyAgentCredentials: injects the Codex token and account id on chatgpt.com", () => {
  const result = applyAgentCredentials(
    allow({ injectHeaders: [{ name: "ChatGPT-Account-Id", value: "other" }] }),
    "chatgpt.com",
    "/backend-api/codex/responses",
    [claude, codex()],
  );
  expect(result.injectHeaders).toEqual([
    { name: "Authorization", value: "Bearer ctok" },
    { name: "chatgpt-account-id", value: "acct-1" },
  ]);
  expect(result.removeHeaders).toBeUndefined();
});

test("applyAgentCredentials: omits the account header when the account is unknown", () => {
  const result = applyAgentCredentials(allow(), "chatgpt.com", "/backend-api", [
    codex({ accessToken: "ctok", accountId: null }),
  ]);
  expect(result.injectHeaders).toEqual([
    { name: "Authorization", value: "Bearer ctok" },
  ]);
});

test("applyAgentCredentials: leaves other hosts and denials unchanged", () => {
  expect(
    applyAgentCredentials(allow(), "example.com", "/", [claude, codex()]),
  ).toEqual(allow());
  const deny: DecisionResponse = { ...allow(), decision: "deny" };
  expect(
    applyAgentCredentials(deny, "chatgpt.com", "/backend-api/x", [codex()]),
  ).toEqual(deny);
});

test("applyAgentCredentials: injects the Codex credential only under /backend-api on chatgpt.com", () => {
  for (const path of [
    "/backend-api",
    "/backend-api/",
    "/backend-api/codex/responses",
    "/backend-api?x=1",
    "/backend-api/wham/usage?x=/y",
  ]) {
    expect(
      applyAgentCredentials(allow(), "chatgpt.com", path, [codex()])
        .injectHeaders,
    ).toBeDefined();
  }
  for (const path of [
    "/",
    "/c/abc",
    "/backend-apix",
    "/backend-api-v2/x",
    "/api/backend-api/x",
    "/?next=/backend-api/",
    undefined,
  ]) {
    expect(
      applyAgentCredentials(allow(), "chatgpt.com", path, [codex()]),
    ).toEqual(allow());
  }
});

test("isHostOwnedCredentialRefresh: matches each agent's token endpoint", () => {
  const creds = [claude, codex()];
  expect(
    isHostOwnedCredentialRefresh(
      creds,
      "platform.claude.com",
      "POST",
      "/v1/oauth/token?x=1",
    ),
  ).toBe(true);
  expect(
    isHostOwnedCredentialRefresh(
      creds,
      "auth.openai.com",
      "post",
      "/oauth/token",
    ),
  ).toBe(true);
  expect(
    isHostOwnedCredentialRefresh(
      creds,
      "auth.openai.com",
      "GET",
      "/oauth/token",
    ),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh(
      [claude],
      "auth.openai.com",
      "POST",
      "/oauth/token",
    ),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh(creds, "auth.openai.com", "POST", undefined),
  ).toBe(false);
});

test("isRevokedCredentialTarget: only where the revoked agent's credential is injected", () => {
  const creds = [claude, codex(null)];
  expect(
    isRevokedCredentialTarget(creds, "chatgpt.com", "/backend-api/x"),
  ).toBe(true);
  expect(isRevokedCredentialTarget(creds, "chatgpt.com", "/c/abc")).toBe(false);
  expect(isRevokedCredentialTarget(creds, "chatgpt.com", undefined)).toBe(
    false,
  );
  expect(
    isRevokedCredentialTarget(creds, "api.anthropic.com", "/v1/messages"),
  ).toBe(false);
  expect(isRevokedCredentialTarget(creds, "example.com", "/")).toBe(false);
});
