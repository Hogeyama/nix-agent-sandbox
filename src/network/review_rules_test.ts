import { describe, expect, test } from "bun:test";
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
