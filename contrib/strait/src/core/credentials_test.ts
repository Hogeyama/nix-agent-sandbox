import { describe, expect, test } from "bun:test";
import type { OutgoingHttpHeaders } from "node:http";
import { buildCredentials } from "./credentials.ts";

const env = {
  GH_TOKEN: "host-gh",
  CLAUDE_CODE_OAUTH_TOKEN: "host-oauth",
  ANTHROPIC_API_KEY: "host-api",
  CUSTOM: "host-custom",
};
const hosts = {
  "dev.example.com": {
    credential: { env: "CUSTOM", header: "private-token", scheme: "Token" },
  },
};

describe("host-owned credentials", () => {
  for (const client of [
    undefined,
    "Bearer attacker",
    "fake_value_gh",
    "fake_value_other",
    ["first", "second"],
  ]) {
    test(`GitHub overwrites ${JSON.stringify(client)}`, () => {
      const credentials = buildCredentials(hosts, env);
      const headers: OutgoingHttpHeaders = {
        authorization: client as string,
        "x-api-key": ["attacker", "other"],
        "x-echo": "fake_value_gh",
      };
      credentials.overwrite(headers, "api.github.com");
      expect(headers).toEqual({
        authorization: "Bearer host-gh",
        "x-echo": "fake_value_gh",
      });
    });
  }
  test("git uses host Basic authentication", () => {
    const c = buildCredentials({}, env);
    const headers = { authorization: "Bearer attacker" };
    c.overwrite(headers, "github.com");
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("x-access-token:host-gh").toString("base64")}`,
    );
  });
  test("Anthropic selects OAuth independently of client headers", () => {
    const c = buildCredentials({}, env);
    const headers: OutgoingHttpHeaders = { "x-api-key": "attacker" };
    c.overwrite(headers, "api.anthropic.com");
    expect(headers).toEqual({ authorization: "Bearer host-oauth" });
  });
  test("Anthropic falls back to the host API key", () => {
    const c = buildCredentials({}, { ANTHROPIC_API_KEY: "host-api" });
    const headers: OutgoingHttpHeaders = { authorization: "attacker" };
    c.overwrite(headers, "api.anthropic.com");
    expect(headers).toEqual({ "x-api-key": "host-api" });
  });
  test("custom header overwrites duplicates and removes other auth", () => {
    const c = buildCredentials(hosts, env);
    const headers: OutgoingHttpHeaders = {
      authorization: "attacker",
      "x-api-key": "attacker",
      "private-token": ["first", "second"],
      "x-echo": "fake_value_other",
    };
    c.overwrite(headers, "dev.example.com");
    expect(headers).toEqual({
      "private-token": "Token host-custom",
      "x-echo": "fake_value_other",
    });
    expect(c.policyHeaders).toEqual({
      "api.github.com": "authorization",
      "github.com": "authorization",
      "api.anthropic.com": "authorization",
      "dev.example.com": "private-token",
    });
    expect(JSON.stringify(c.policyHeaders)).not.toContain("host-custom");
  });
  test("missing host credentials never retain client auth", () => {
    const c = buildCredentials({}, {});
    const headers: OutgoingHttpHeaders = {
      authorization: "attacker",
      "x-api-key": "attacker",
      "x-echo": "fake_value_gh",
    };
    c.overwrite(headers, "api.github.com");
    expect(headers).toEqual({ "x-echo": "fake_value_gh" });
    expect(c.policyHeaders).toEqual({});
  });
  test("all masked env vars have no substitution hosts, even shared secrets", () => {
    const c = buildCredentials(hosts, { ...env, CUSTOM: env.GH_TOKEN });
    expect(c.maskedEnvVars.map((v) => v.name)).toEqual([
      "GH_TOKEN",
      "STRAIT_GIT_AUTH",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CUSTOM",
    ]);
    expect(
      c.maskedEnvVars.every(
        (v) => v.mode === "mask" && v.injectHosts.length === 0,
      ),
    ).toBe(true);
  });
  test("required configured credential is checked at startup", () => {
    expect(() => buildCredentials(hosts, {})).toThrow("CUSTOM is not set");
  });
});

test("invalid host header bytes fail startup without revealing the value", () => {
  expect(() => buildCredentials({}, { GH_TOKEN: "secret\ninvalid" })).toThrow(
    "invalid host credential header value",
  );
});
test("mask verification counts separate variables sharing a secret", () => {
  const c = buildCredentials(
    {
      "same.example.com": {
        credential: { env: "CUSTOM", header: "private-token" },
      },
    },
    { GH_TOKEN: "shared", CUSTOM: "shared" },
  );
  expect(() =>
    c.assertMasked([
      ["one", "shared"],
      ["git", c.gitAuthorization ?? ""],
    ]),
  ).toThrow("srt did not mask CUSTOM");
  expect(() =>
    c.assertMasked([
      ["one", "shared"],
      ["two", "shared"],
      ["git", c.gitAuthorization ?? ""],
    ]),
  ).not.toThrow();
});
