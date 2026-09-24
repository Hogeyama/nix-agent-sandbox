import { expect, test } from "bun:test";
import {
  applyAgentCredential,
  isHostOwnedCredentialRefresh,
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

test("applyAgentCredential: injects the bearer token and removes x-api-key for Anthropic hosts", () => {
  for (const host of ["api.anthropic.com", "mcp-proxy.anthropic.com"]) {
    expect(applyAgentCredential(allow(), host, "tok")).toEqual(
      allow({
        injectHeaders: [{ name: "Authorization", value: "Bearer tok" }],
        removeHeaders: ["x-api-key"],
      }),
    );
  }
});

test("applyAgentCredential: replaces a user-configured Authorization inject of any case", () => {
  const result = applyAgentCredential(
    allow({
      injectHeaders: [
        { name: "authorization", value: "user" },
        { name: "x-extra", value: "kept" },
      ],
    }),
    "api.anthropic.com",
    "tok",
  );
  expect(result.injectHeaders).toEqual([
    { name: "x-extra", value: "kept" },
    { name: "Authorization", value: "Bearer tok" },
  ]);
});

test("applyAgentCredential: leaves other hosts and non-allow decisions untouched", () => {
  const other = allow();
  expect(applyAgentCredential(other, "platform.claude.com", "tok")).toBe(other);
  const denied = allow({ decision: "deny" });
  expect(applyAgentCredential(denied, "api.anthropic.com", "tok")).toBe(denied);
});

test("isHostOwnedCredentialRefresh: matches only POST /v1/oauth/token on platform.claude.com", () => {
  expect(
    isHostOwnedCredentialRefresh(
      "platform.claude.com",
      "POST",
      "/v1/oauth/token",
    ),
  ).toBe(true);
  expect(
    isHostOwnedCredentialRefresh(
      "platform.claude.com",
      "post",
      "/v1/oauth/token?x=1",
    ),
  ).toBe(true);
  expect(
    isHostOwnedCredentialRefresh(
      "platform.claude.com",
      "GET",
      "/v1/oauth/token",
    ),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh(
      "platform.claude.com",
      "POST",
      "/v1/oauth/other",
    ),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh(
      "api.anthropic.com",
      "POST",
      "/v1/oauth/token",
    ),
  ).toBe(false);
  expect(
    isHostOwnedCredentialRefresh("platform.claude.com", "POST", undefined),
  ).toBe(false);
});
