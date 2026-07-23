import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { JsonRequestPolicy, ReviewRule } from "../config/types.ts";
import {
  matchesReviewRule,
  resolveReviewRules,
  reviewRuleSubsumes,
} from "./review_rules.ts";

const BODYLESS = { kind: "bodyless" } as const;
const JSON_POLICY: JsonRequestPolicy = {
  kind: "json",
  maxBodyBytes: 1024,
  maxDepth: 8,
  maxNodes: 100,
  maxDecodedBytes: 512,
  taggedUnions: [
    {
      at: "/messages/*/content/**",
      discriminator: "type",
      allowedTags: ["text", "tool_use"],
    },
  ],
  encodedFields: [
    {
      at: "/messages/*/source",
      whenField: "type",
      whenEquals: "base64",
      dataField: "data",
      encoding: "base64",
    },
  ],
};

function bodylessRule(overrides: Partial<ReviewRule> = {}): ReviewRule {
  return {
    id: "bodyless.settings",
    method: "GET",
    host: "api.example.com",
    path: "/settings",
    action: "allow",
    requestPolicy: BODYLESS,
    ...overrides,
  };
}

function jsonRule(overrides: Partial<ReviewRule> = {}): ReviewRule {
  return {
    id: "messages.create",
    method: "POST",
    host: "api.example.com",
    path: "/v1/messages",
    action: "allow",
    requestPolicy: JSON_POLICY,
    ...overrides,
  };
}

function anthropicPreset(
  overrides: Partial<{
    id: string;
    preset: string;
    host: string;
    removeRules: string[];
    addRules: ReviewRule[];
  }> = {},
) {
  return {
    id: "anthropic",
    preset: "anthropic@1",
    removeRules: [],
    addRules: [],
    ...overrides,
  };
}

describe("resolveReviewRules custom rules", () => {
  test("preserves ID-less ordinary rules with explicit audit default", () => {
    const input: ReviewRule = {
      host: "*.example.com",
      pathPrefix: "/api",
      action: "review",
    };

    expect(resolveReviewRules([input])).toEqual({
      contractVersion: 1,
      rules: [{ ...input, audit: true }],
    });
  });

  test("clones nested policy values", () => {
    const input = jsonRule();
    const resolved = resolveReviewRules([input]);

    expect(resolved.rules[0]).not.toBe(input);
    expect(resolved.rules[0].requestPolicy).not.toBe(input.requestPolicy);
    if (
      input.requestPolicy?.kind === "json" &&
      resolved.rules[0].requestPolicy?.kind === "json"
    ) {
      expect(resolved.rules[0].requestPolicy.taggedUnions).not.toBe(
        input.requestPolicy.taggedUnions,
      );
      expect(resolved.rules[0].requestPolicy.encodedFields).not.toBe(
        input.requestPolicy.encodedFields,
      );
      expect(
        resolved.rules[0].requestPolicy.taggedUnions[0].allowedTags,
      ).not.toBe(input.requestPolicy.taggedUnions[0].allowedTags);
    }
  });

  test("accepts a safe 64-byte ID", () => {
    expect(() =>
      resolveReviewRules([bodylessRule({ id: `a${"0".repeat(63)}` })]),
    ).not.toThrow();
  });

  test.each([
    ["uppercase", "Unsafe"],
    ["leading digit", "1unsafe"],
    ["non-ASCII", "é"],
    ["65 bytes", `a${"0".repeat(64)}`],
    ["final newline", "safe\n"],
  ])("rejects unsafe ID: %s", (_name, id) => {
    expect(() => resolveReviewRules([bodylessRule({ id })])).toThrow(
      /invalid rule ID/,
    );
  });

  test("rejects path together with pathPrefix", () => {
    expect(() =>
      resolveReviewRules([{ ...bodylessRule(), pathPrefix: "/settings" }]),
    ).toThrow(/path.*pathPrefix.*mutually exclusive/);
  });

  test.each([
    ["id", { id: undefined }],
    ["method", { method: undefined }],
    ["host", { host: undefined }],
    ["path", { path: undefined }],
  ])("rejects custom policy missing %s", (_name, overrides) => {
    expect(() => resolveReviewRules([bodylessRule(overrides)])).toThrow(
      /requestPolicy requires/,
    );
  });

  test.each([
    ["wildcard", "*.example.com"],
    ["port", "api.example.com:443"],
  ])("rejects custom policy with %s host", (_name, host) => {
    expect(() => resolveReviewRules([bodylessRule({ host })])).toThrow(
      /exact non-port host/,
    );
  });

  test.each([
    ["leading whitespace", " api.example.com"],
    ["trailing whitespace", "api.example.com "],
    ["scheme", "https://api.example.com"],
    ["path", "api.example.com/v1"],
    ["query", "api.example.com?x=1"],
    ["fragment", "api.example.com#fragment"],
    ["userinfo", "user@api.example.com"],
    ["wildcard", "*.example.com"],
    ["brackets", "[api.example.com]"],
    ["port", "api.example.com:443"],
    ["malformed port", "api.example.com:not-a-port"],
    ["empty port", "api.example.com:"],
    ["colon", ":"],
    ["empty label", "api..example.com"],
    ["leading label hyphen", "-api.example.com"],
    ["trailing label hyphen", "api-.example.com"],
    ["invalid label character", "api_example.com"],
    ["64-byte label", `${"a".repeat(64)}.example.com`],
    [
      "254-byte hostname",
      ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join(
        ".",
      ),
    ],
  ])("rejects invalid exact policy host: %s", (_name, host) => {
    expect(() => resolveReviewRules([bodylessRule({ host })])).toThrow(
      /exact non-port host/,
    );
  });

  test.each([
    ["mixed case", "API.Example.COM"],
    ["trailing FQDN dot", "api.example.com."],
    ["63-byte label", `${"a".repeat(63)}.example.com`],
    [
      "253-byte hostname",
      ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(
        ".",
      ),
    ],
  ])("accepts valid exact policy host boundary: %s", (_name, host) => {
    expect(() => resolveReviewRules([bodylessRule({ host })])).not.toThrow();
  });

  test("matches an accepted case/trailing-dot policy host canonically", () => {
    const resolved = resolveReviewRules([
      bodylessRule({ host: "API.Example.COM." }),
    ]);
    expect(
      matchesReviewRule(resolved.rules[0], {
        method: "GET",
        target: { host: "api.example.com", port: 443 },
        path: "/settings",
      }),
    ).toBe(true);
  });

  test("rejects deny plus request policy", () => {
    expect(() =>
      resolveReviewRules([bodylessRule({ action: "deny" })]),
    ).toThrow(/deny.*requestPolicy/);
  });

  test.each([
    ["bodyless", bodylessRule({ method: "POST" }), /bodyless.*GET/],
    ["json", jsonRule({ method: "GET" }), /json.*POST/],
  ])("rejects wrong method for %s policy", (_name, rule, message) => {
    expect(() => resolveReviewRules([rule])).toThrow(message);
  });

  test("rejects unknown policy kind", () => {
    expect(() =>
      resolveReviewRules([
        bodylessRule({
          requestPolicy: { kind: "graphql" } as never,
        }),
      ]),
    ).toThrow(/unknown requestPolicy kind/);
  });

  test.each([
    ["maxBodyBytes", 0],
    ["maxBodyBytes", 33_554_433],
    ["maxDepth", -1],
    ["maxDepth", 65],
    ["maxNodes", 0.5],
    ["maxNodes", 200_001],
    ["maxDecodedBytes", Number.NaN],
    ["maxDecodedBytes", 33_554_433],
  ])("rejects invalid custom limit %s=%s", (field, value) => {
    const policy = { ...JSON_POLICY, [field]: value };
    expect(() =>
      resolveReviewRules([jsonRule({ requestPolicy: policy })]),
    ).toThrow(new RegExp(`${field}.*positive integer.*at most`));
  });

  test.each([
    ["not absolute", "messages/*"],
    ["bad escape", "/messages/~2"],
    ["partial wildcard", "/messages/pre*"],
    ["leading partial wildcard", "/messages/*post"],
    ["embedded partial wildcard", "/messages/pre*post"],
  ])("rejects malformed selector: %s", (_name, at) => {
    const policy = {
      ...JSON_POLICY,
      taggedUnions: [{ ...JSON_POLICY.taggedUnions[0], at }],
    };
    expect(() =>
      resolveReviewRules([jsonRule({ requestPolicy: policy })]),
    ).toThrow(/selector/);
  });

  test.each([
    ["dollar-prefixed", "/$schema"],
    ["pipe", "/foo|bar"],
    ["regex-looking escape", String.raw`/\d+`],
    ["regex-looking group", "/(.*)"],
    ["filter-looking", "/[?(@.type)]"],
    ["script-looking", "/$" + "{danger}"],
  ])("accepts expression-looking selector text as a literal: %s", (_name, at) => {
    const policy = {
      ...JSON_POLICY,
      taggedUnions: [{ ...JSON_POLICY.taggedUnions[0], at }],
    };
    expect(() =>
      resolveReviewRules([jsonRule({ requestPolicy: policy })]),
    ).not.toThrow();
  });

  test("accepts valid pointer escapes and whole-segment wildcards", () => {
    const policy = {
      ...JSON_POLICY,
      taggedUnions: [
        { ...JSON_POLICY.taggedUnions[0], at: "/~0meta/~1path/*/**" },
      ],
    };
    expect(() =>
      resolveReviewRules([jsonRule({ requestPolicy: policy })]),
    ).not.toThrow();
  });

  test("rejects unknown encoded-field encoding", () => {
    const policy = {
      ...JSON_POLICY,
      encodedFields: [
        { ...JSON_POLICY.encodedFields[0], encoding: "base64url" },
      ],
    };
    expect(() =>
      resolveReviewRules([jsonRule({ requestPolicy: policy as never })]),
    ).toThrow(/encoding.*base64/);
  });

  test("rejects duplicate IDs", () => {
    expect(() =>
      resolveReviewRules([bodylessRule(), bodylessRule({ path: "/other" })]),
    ).toThrow(/duplicate rule ID/);
  });

  test("aggregates rule errors and list validation with original indices", () => {
    expect(() =>
      resolveReviewRules([
        bodylessRule({ method: "POST" }),
        {
          id: "ordinary.duplicate",
          host: "first.example.com",
          action: "allow",
        },
        {
          id: "ordinary.duplicate",
          host: "second.example.com",
          action: "review",
        },
      ]),
    ).toThrow(
      /reviewRules\[0\].*bodyless.*GET[\s\S]*reviewRules\[2\].*duplicate rule ID.*reviewRules\[1\]/,
    );
  });

  test("rejects duplicate exact endpoints case-insensitively", () => {
    expect(() =>
      resolveReviewRules([
        bodylessRule(),
        bodylessRule({
          id: "bodyless.duplicate",
          method: "get",
          host: "API.EXAMPLE.COM",
        }),
      ]),
    ).toThrow(/duplicate exact endpoint/);
  });

  test("rejects duplicate exact endpoints after host-port canonicalization", () => {
    expect(() =>
      resolveReviewRules([
        {
          id: "ordinary.first",
          method: "GET",
          host: "example.com:443",
          path: "/same",
          action: "allow",
        },
        {
          id: "ordinary.second",
          method: "get",
          host: "EXAMPLE.COM.:443",
          path: "/same",
          action: "review",
        },
      ]),
    ).toThrow(/duplicate exact endpoint/);
  });

  test("keeps different endpoint ports distinct", () => {
    expect(() =>
      resolveReviewRules([
        {
          id: "ordinary.https",
          method: "GET",
          host: "example.com:443",
          path: "/same",
          action: "allow",
        },
        {
          id: "ordinary.alt",
          method: "get",
          host: "EXAMPLE.COM.:8443",
          path: "/same",
          action: "review",
        },
      ]),
    ).not.toThrow();
  });

  test.each([
    "...",
    "example.com:99999",
    "[broken",
  ])("does not crash duplicate validation for malformed ordinary host %s", (host) => {
    expect(() =>
      resolveReviewRules([
        {
          id: "ordinary.malformed",
          method: "GET",
          host,
          path: "/same",
          action: "allow",
        },
      ]),
    ).not.toThrow();
  });
});

describe("matchesReviewRule exact path", () => {
  const rule = bodylessRule({ path: "/v1/a%2Fb//" });

  test.each([
    ["/v1/a%2Fb//", true],
    ["/v1/a%2Fb//?beta=1?still-query", true],
    ["/v1/a/b//", false],
    ["/v1/a%2fb//", false],
    ["/v1/a%2Fb/", false],
    ["/v1/a%2Fb///", false],
  ])("matches raw query-free path %s = %s", (path, expected) => {
    expect(
      matchesReviewRule(rule, {
        method: "get",
        target: { host: "api.example.com", port: 8443 },
        path,
      }),
    ).toBe(expected);
  });
});

describe("review rule shadow subsumption", () => {
  const protectedRule = bodylessRule();

  test.each([
    ["absent method", { method: undefined }, true],
    ["equal method", { method: "get" }, true],
    ["different method", { method: "POST" }, false],
    ["absent host", { host: undefined }, true],
    ["equal host", { host: "API.EXAMPLE.COM" }, true],
    ["matching wildcard host", { host: "*.example.com" }, true],
    ["different host", { host: "other.example.com" }, false],
    ["port host", { host: "api.example.com:443" }, false],
    ["absent path", { path: undefined }, true],
    ["equal exact path", { path: "/settings" }, true],
    ["ancestor prefix", { path: undefined, pathPrefix: "/" }, true],
    [
      "segment ancestor prefix",
      { path: undefined, pathPrefix: "/settings" },
      true,
    ],
    ["non-boundary prefix", { path: undefined, pathPrefix: "/setting" }, false],
    ["different exact path", { path: "/other" }, false],
  ])("%s", (_name, overrides, expected) => {
    const earlier = { ...protectedRule, id: undefined, ...overrides };
    expect(reviewRuleSubsumes(earlier, protectedRule)).toBe(expected);
  });

  test("an exact path cannot subsume a protected prefix", () => {
    const earlier = {
      ...protectedRule,
      path: "/settings",
      pathPrefix: undefined,
    };
    const later = {
      ...protectedRule,
      path: undefined,
      pathPrefix: "/settings",
    };
    expect(reviewRuleSubsumes(earlier, later)).toBe(false);
  });

  test("action does not affect subsumption", () => {
    const earlier = { ...protectedRule, action: "deny" } as const;
    const later = { ...protectedRule, action: "allow" } as const;
    expect(reviewRuleSubsumes(earlier, later)).toBe(true);
  });

  test.each([
    "*.",
    "...",
    "[broken",
    "example.com:99999",
  ])("returns false instead of throwing for malformed earlier host %s", (host) => {
    expect(reviewRuleSubsumes({ ...protectedRule, host }, protectedRule)).toBe(
      false,
    );
  });

  test.each([
    "*.",
    "...",
    "[broken",
    "example.com:99999",
  ])("returns false instead of throwing for malformed later host %s", (host) => {
    expect(
      reviewRuleSubsumes(
        { ...protectedRule, host: undefined },
        { ...protectedRule, host },
      ),
    ).toBe(false);
  });
});

describe("resolveReviewRules protected shadowing", () => {
  test("rejects an earlier rule that shadows a policy rule", () => {
    expect(() =>
      resolveReviewRules([
        { host: "*.example.com", action: "review" },
        bodylessRule(),
      ]),
    ).toThrow(/reviewRules\[0\].*shadows protected.*bodyless\.settings/);
  });

  test("allows an earlier rule when subsumption cannot be proven", () => {
    expect(() =>
      resolveReviewRules([
        { host: "api.example.com:443", action: "review" },
        bodylessRule(),
      ]),
    ).not.toThrow();
  });
});

describe("resolveReviewRules anthropic preset overlays", () => {
  test("expands inline and inserts additions before the terminal deny", () => {
    const resolved = resolveReviewRules([
      { id: "before", host: "before.example.com", action: "review" },
      anthropicPreset({
        addRules: [
          {
            id: "company-bootstrap",
            method: "GET",
            path: "/company/bootstrap",
            action: "review",
            requestPolicy: BODYLESS,
          },
        ],
      }),
      { id: "after", host: "after.example.com", action: "review" },
    ]);

    expect(resolved.rules[0].id).toBe("before");
    expect(resolved.rules.at(-1)?.id).toBe("after");
    expect(resolved.rules.map((rule) => rule.id)).toEqual([
      "before",
      "anthropic.messages.create",
      "anthropic.messages.count-tokens",
      "anthropic.bodyless.bootstrap",
      "anthropic.bodyless.penguin-mode",
      "anthropic.bodyless.policy-limits",
      "anthropic.bodyless.settings",
      "anthropic.bodyless.mcp-registry",
      "anthropic.bodyless.code-triggers",
      "anthropic.bodyless.mcp-servers",
      "anthropic.company-bootstrap",
      "anthropic.default-deny",
      "after",
    ]);
  });

  test("removing the terminal rule appends additions after remaining rules", () => {
    const resolved = resolveReviewRules([
      anthropicPreset({
        removeRules: ["default-deny"],
        addRules: [
          {
            id: "company-bootstrap",
            method: "GET",
            path: "/company/bootstrap",
            action: "review",
            requestPolicy: BODYLESS,
          },
        ],
      }),
    ]);

    expect(resolved.rules.at(-1)?.id).toBe("anthropic.company-bootstrap");
    expect(resolved.rules.some((rule) => rule.action === "deny")).toBe(false);
  });

  test("allows a removed local ID to be replaced", () => {
    const resolved = resolveReviewRules([
      anthropicPreset({
        removeRules: ["bodyless.settings"],
        addRules: [
          {
            id: "bodyless.settings",
            method: "GET",
            path: "/company/settings",
            action: "review",
            requestPolicy: BODYLESS,
          },
        ],
      }),
    ]);

    expect(
      resolved.rules.find((rule) => rule.id === "anthropic.bodyless.settings"),
    ).toMatchObject({
      host: "api.anthropic.com",
      path: "/company/settings",
      action: "review",
    });
  });

  test.each([
    [
      "unknown removal",
      { removeRules: ["missing"] },
      /unknown removeRules.*missing/,
    ],
    [
      "duplicate removal",
      { removeRules: ["bodyless.settings", "bodyless.settings"] },
      /duplicate removeRules.*bodyless\.settings/,
    ],
    [
      "reused ID without removal",
      {
        addRules: [
          {
            id: "bodyless.settings",
            method: "GET",
            path: "/company/settings",
            action: "allow",
            requestPolicy: BODYLESS,
          },
        ],
      },
      /duplicate.*bodyless\.settings/,
    ],
    [
      "duplicate added endpoint",
      {
        addRules: [
          {
            id: "duplicate-messages",
            method: "POST",
            path: "/v1/messages",
            action: "allow",
            requestPolicy: JSON_POLICY,
          },
        ],
      },
      /duplicate exact endpoint/,
    ],
  ])("rejects %s", (_name, overrides, expected) => {
    expect(() =>
      resolveReviewRules([anthropicPreset(overrides as never)]),
    ).toThrow(expected);
  });

  test("rejects an unknown preset version", () => {
    expect(() =>
      resolveReviewRules([anthropicPreset({ preset: "anthropic@2" })]),
    ).toThrow(/unknown preset "anthropic@2"/);
  });

  test("applies an exact host override and inherits it in additions", () => {
    const resolved = resolveReviewRules([
      anthropicPreset({
        host: "gateway.example.com",
        addRules: [
          {
            id: "company-bootstrap",
            method: "GET",
            path: "/company/bootstrap",
            action: "allow",
            requestPolicy: BODYLESS,
          },
        ],
      }),
    ]);

    expect(
      resolved.rules.every((rule) => rule.host === "gateway.example.com"),
    ).toBe(true);
  });

  test.each([
    [
      "policyless allow",
      {
        addRules: [
          {
            id: "policyless-allow",
            method: "GET",
            path: "/company/allow",
            action: "allow",
          },
        ],
      },
      "policyless-allow",
    ],
    [
      "policyless review",
      {
        addRules: [
          {
            id: "policyless-review",
            method: "GET",
            path: "/company/review",
            action: "review",
          },
        ],
      },
      "policyless-review",
    ],
    [
      "policyless replacement",
      {
        removeRules: ["bodyless.settings"],
        addRules: [
          {
            id: "bodyless.settings",
            method: "GET",
            path: "/company/settings",
            action: "allow",
          },
        ],
      },
      "bodyless.settings",
    ],
    [
      "policyless Files-like allow route",
      {
        addRules: [
          {
            id: "files-upload",
            method: "POST",
            path: "/v1/files",
            action: "allow",
          },
        ],
      },
      "files-upload",
    ],
  ])("rejects %s", (_name, overrides, additionId) => {
    expect(() =>
      resolveReviewRules([anthropicPreset(overrides as never)]),
    ).toThrow(
      new RegExp(
        `reviewRules\\[0\\].*anthropic.*addRules ID "${additionId.replace(".", "\\.")}".*requestPolicy`,
      ),
    );
  });

  test("accepts a policyless deny addition", () => {
    const resolved = resolveReviewRules([
      anthropicPreset({
        addRules: [
          {
            id: "deny-files",
            method: "POST",
            path: "/v1/files",
            action: "deny",
          },
        ],
      }),
    ]);

    expect(
      resolved.rules.find((rule) => rule.id === "anthropic.deny-files"),
    ).toEqual({
      id: "anthropic.deny-files",
      method: "POST",
      host: "api.anthropic.com",
      path: "/v1/files",
      action: "deny",
      audit: true,
    });
  });

  test.each([
    ["wildcard override", { host: "*.example.com" }],
    [
      "mismatched addition host",
      {
        host: "gateway.example.com",
        addRules: [
          {
            id: "company-bootstrap",
            method: "GET",
            host: "api.anthropic.com",
            path: "/company/bootstrap",
            action: "allow",
            requestPolicy: BODYLESS,
          },
        ],
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expect(() =>
      resolveReviewRules([anthropicPreset(overrides as never)]),
    ).toThrow(/host/);
  });

  test.each([
    ["unsafe namespace", anthropicPreset({ id: "Unsafe" })],
    ["namespace ID overflow", anthropicPreset({ id: `a${"0".repeat(64)}` })],
    [
      "unsafe local ID",
      anthropicPreset({
        addRules: [
          {
            id: "Unsafe",
            method: "GET",
            path: "/company/bootstrap",
            action: "allow",
          },
        ],
      }),
    ],
    [
      "local ID overflow",
      anthropicPreset({
        addRules: [
          {
            id: `a${"0".repeat(64)}`,
            method: "GET",
            path: "/company/bootstrap",
            action: "allow",
          },
        ],
      }),
    ],
    ["composed ID overflow", anthropicPreset({ id: `a${"0".repeat(54)}` })],
  ])("rejects %s", (_name, preset) => {
    expect(() => resolveReviewRules([preset])).toThrow(/invalid.*ID/);
  });

  test("rejects a broad prior rule that shadows the preset", () => {
    expect(() =>
      resolveReviewRules([
        { host: "*.anthropic.com", action: "review" },
        anthropicPreset(),
      ]),
    ).toThrow(/reviewRules\[0\].*shadows protected reviewRules\[1\]/);
  });

  test("returns fresh clones rather than mutable preset data", () => {
    const first = resolveReviewRules([anthropicPreset()]);
    first.rules[0].host = "mutated.example.com";
    if (first.rules[0].requestPolicy?.kind === "json") {
      first.rules[0].requestPolicy.taggedUnions[0].allowedTags.push("fallback");
    }

    const second = resolveReviewRules([anthropicPreset()]);
    expect(second.rules[0].host).toBe("api.anthropic.com");
    expect(
      second.rules[0].requestPolicy?.kind === "json" &&
        second.rules[0].requestPolicy.taggedUnions[0].allowedTags,
    ).not.toContain("fallback");
  });
});

test("anthropic preset matches the versioned cross-language fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/resolved_review_rules/anthropic-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const resolved = resolveReviewRules([anthropicPreset()]);

  expect(resolved).toEqual(fixture);
  expect(resolved.contractVersion).toBe(1);
  expect(
    resolved.rules.every(
      (rule) =>
        rule.id !== undefined && /^[a-z][a-z0-9._-]{0,63}$/.test(rule.id),
    ),
  ).toBe(true);
  expect(JSON.stringify(resolved)).not.toContain("fallback");
  const allowedPaths = resolved.rules
    .filter((rule) => rule.action === "allow")
    .map((rule) => rule.path);
  expect(
    allowedPaths.some(
      (path) =>
        path === "/v1/files" ||
        path?.startsWith("/v1/files/") ||
        path?.includes("telemetry") ||
        path?.includes("eval"),
    ),
  ).toBe(false);
  const jsonPolicy = resolved.rules[0].requestPolicy;
  expect(jsonPolicy?.kind).toBe("json");
  expect(
    jsonPolicy?.kind === "json"
      ? jsonPolicy.taggedUnions.map((guard) => guard.allowedTags.length)
      : [],
  ).toEqual([14, 14]);
  expect(
    jsonPolicy?.kind === "json"
      ? jsonPolicy.taggedUnions.map((guard) => guard.at)
      : [],
  ).toEqual(["/**/content/*", "/**/system/*"]);
  expect(jsonPolicy?.kind === "json" ? jsonPolicy.encodedFields : []).toEqual([
    {
      at: "/**",
      whenField: "type",
      whenEquals: "base64",
      dataField: "data",
      encoding: "base64",
    },
  ]);
  expect(resolved.rules.at(-1)).toEqual({
    id: "anthropic.default-deny",
    host: "api.anthropic.com",
    action: "deny",
    audit: true,
  });
});
