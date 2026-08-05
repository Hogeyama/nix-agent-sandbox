import { expect, test } from "bun:test";
import { documentWithScopes } from "./authz/testing.ts";
import {
  decodeProxyAuthorization,
  denyReasonForTarget,
  matchesHostPattern,
  matchesPathPrefix,
  normalizeHost,
  normalizeTarget,
  parseAllowlistEntry,
  validateRequestPolicyOutcome,
} from "./protocol.ts";

const document = documentWithScopes({
  policy: {
    targets: ["api.example.com"],
    fallback: "deny",
    rules: {
      bodyless: {
        match: { methods: ["GET"], paths: ["/health"] },
        onMatch: "allow",
        expect: [{ kind: "emptyBody" }],
      },
      json: {
        match: {
          methods: ["POST"],
          paths: ["/v1/messages"],
          body: { format: "json" },
        },
        onMatch: "allow",
      },
    },
  },
});

const validOutcome = {
  version: 1,
  type: "request_policy_outcome",
  requestId: "req-json",
  sessionId: "sess_test",
  ruleId: "policy.json",
  result: "pass",
  reason: "recognized-json",
};

const acceptedOutcomes = [
  [
    "a rule that passed its acceptance conditions",
    "policy.json",
    "pass",
    "recognized-json",
  ],
  [
    "a body rewritten by secret masking",
    "policy.json",
    "rewrite",
    "masked-json",
  ],
  ["an empty body a rule required", "policy.bodyless", "pass", "empty-body"],
  [
    "a rule with nothing to inspect",
    "policy.bodyless",
    "pass",
    "no-inspection",
  ],
  [
    "violations the rule chose to record",
    "policy.json",
    "pass",
    "violations-allowed",
  ],
  [
    "a scope fallback that inspected nothing",
    "policy.$fallback",
    "pass",
    "no-inspection",
  ],
  ["a body that could not be read", "policy.json", "block", "body-unavailable"],
  [
    "a body present where none was allowed",
    "policy.bodyless",
    "block",
    "unexpected-body",
  ],
  ["a body that is not JSON", "policy.json", "block", "invalid-json"],
  ["a shape the rule did not allow", "policy.json", "block", "schema-mismatch"],
  [
    "a forbidden secret in the request",
    "policy.json",
    "block",
    "forbidden-secret",
  ],
  [
    "an inspection that ran out of budget",
    "policy.json",
    "block",
    "resource-limit",
  ],
  [
    "masking that would collide two keys",
    "policy.json",
    "block",
    "key-collision",
  ],
  [
    "a masked body that would not serialize",
    "policy.json",
    "block",
    "serialization-failed",
  ],
  ["an inspection that fell over", "policy.json", "block", "processing-failed"],
  [
    "a body that was masked while carrying an allowed violation",
    "policy.json",
    "rewrite",
    "violations-allowed",
  ],
] as const;

for (const [name, ruleId, result, reason] of acceptedOutcomes) {
  test(`request policy outcome validation accepts ${name}`, () => {
    expect(
      validateRequestPolicyOutcome(
        { ...validOutcome, ruleId, result, reason },
        "sess_test",
        document,
      ),
    ).toBeNull();
  });
}

const invalidPolicyOutcomes = [
  ["session mismatch", { sessionId: "sess_other" }],
  ["malformed rule ID", { ruleId: "Policy JSON" }],
  ["unknown rule ID", { ruleId: "policy.unknown" }],
  ["a rule ID from another scope", { ruleId: "other.json" }],
  ["ID-less rule cannot be addressed", { ruleId: "" }],
  ["unknown result", { result: "allow" }],
  ["unknown reason", { reason: "raw-error-detail" }],
  [
    "rewrite with a pass reason",
    { result: "rewrite", reason: "recognized-json" },
  ],
  ["pass with a rewrite reason", { result: "pass", reason: "masked-json" }],
  ["block with success reason", { result: "block", reason: "recognized-json" }],
  ["pass with a block reason", { result: "pass", reason: "invalid-json" }],
  ["unknown field", { target: "sensitive.example" }],
] as const;

for (const [name, overrides] of invalidPolicyOutcomes) {
  test(`request policy outcome validation rejects ${name}`, () => {
    expect(
      validateRequestPolicyOutcome(
        { ...validOutcome, ...overrides },
        "sess_test",
        document,
      ),
    ).not.toBeNull();
  });
}

test("decodeProxyAuthorization: decodes Basic credentials", () => {
  const header = `Basic ${btoa("sess_abc:tok_xyz")}`;
  expect(decodeProxyAuthorization(header)).toEqual({
    sessionId: "sess_abc",
    token: "tok_xyz",
  });
});

test("decodeProxyAuthorization: rejects malformed credentials", () => {
  expect(decodeProxyAuthorization("Bearer token")).toEqual(null);
  expect(decodeProxyAuthorization(`Basic ${btoa("sess_only:")}`)).toEqual(null);
  expect(decodeProxyAuthorization("Basic !!!")).toEqual(null);
});

test("normalizeTarget: parses CONNECT authority", () => {
  const target = normalizeTarget({
    method: "CONNECT",
    authority: "api.openai.com:443",
  });
  expect(target).toEqual({ host: "api.openai.com", port: 443 });
});

test("normalizeTarget: parses absolute URI", () => {
  const target = normalizeTarget({
    method: "GET",
    url: "https://example.com/path",
  });
  expect(target).toEqual({ host: "example.com", port: 443 });
});

test("normalizeTarget: CONNECT requires an explicit port", () => {
  expect(() =>
    normalizeTarget({
      method: "CONNECT",
      authority: "api.openai.com",
    }),
  ).toThrow("explicit port");
});

test("normalizeTarget: falls back to authority when URL is invalid", () => {
  const target = normalizeTarget({
    method: "GET",
    url: "not a valid url",
    hostHeader: "Example.COM.",
  });
  expect(target).toEqual({ host: "example.com", port: 80 });
});

test("normalizeHost: trims brackets, dots, and case", () => {
  expect(normalizeHost("[2001:db8::1]")).toEqual("2001:db8::1");
  expect(normalizeHost("Example.COM...")).toEqual("example.com");
});

test("parseAllowlistEntry: parses host only", () => {
  expect(parseAllowlistEntry("example.com")).toEqual({
    host: "example.com",
    port: null,
  });
  expect(parseAllowlistEntry("*.example.com")).toEqual({
    host: "*.example.com",
    port: null,
  });
});

test("parseAllowlistEntry: parses host:port", () => {
  expect(parseAllowlistEntry("example.com:443")).toEqual({
    host: "example.com",
    port: 443,
  });
  expect(parseAllowlistEntry("*.example.com:8080")).toEqual({
    host: "*.example.com",
    port: 8080,
  });
});

test("parseAllowlistEntry: parses IPv6 with brackets", () => {
  expect(parseAllowlistEntry("[2001:db8::1]")).toEqual({
    host: "[2001:db8::1]",
    port: null,
  });
  expect(parseAllowlistEntry("[2001:db8::1]:443")).toEqual({
    host: "[2001:db8::1]",
    port: 443,
  });
});

test("matchesHostPattern: supports wildcard subdomains", () => {
  expect(
    matchesHostPattern({ host: "api.github.com", port: 443 }, ["*.github.com"]),
  ).toEqual(true);
  expect(
    matchesHostPattern({ host: "github.com", port: 443 }, ["*.github.com"]),
  ).toEqual(true);
  expect(
    matchesHostPattern({ host: "gitlab.com", port: 443 }, ["*.github.com"]),
  ).toEqual(false);
});

test("matchesHostPattern: port-qualified entries", () => {
  expect(
    matchesHostPattern({ host: "example.com", port: 443 }, ["example.com:443"]),
  ).toEqual(true);
  expect(
    matchesHostPattern({ host: "example.com", port: 80 }, ["example.com:443"]),
  ).toEqual(false);
  expect(
    matchesHostPattern({ host: "example.com", port: 80 }, ["example.com"]),
  ).toEqual(true);
  expect(
    matchesHostPattern({ host: "api.example.com", port: 443 }, [
      "*.example.com:443",
    ]),
  ).toEqual(true);
  expect(
    matchesHostPattern({ host: "api.example.com", port: 80 }, [
      "*.example.com:443",
    ]),
  ).toEqual(false);
});

test("denyReasonForTarget: blocks localhost and RFC1918", () => {
  expect(denyReasonForTarget({ host: "localhost", port: 80 })).toEqual(
    "blocked-special-host",
  );
  expect(denyReasonForTarget({ host: "10.0.0.1", port: 443 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "127.0.0.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "172.16.0.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "172.31.255.255", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "192.168.1.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "169.254.0.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  // Public addresses should pass
  expect(denyReasonForTarget({ host: "example.com", port: 443 })).toEqual(null);
  expect(denyReasonForTarget({ host: "8.8.8.8", port: 443 })).toEqual(null);
  expect(denyReasonForTarget({ host: "172.32.0.1", port: 80 })).toEqual(null);
});

test("denyReasonForTarget: blocks private and link-local IPv6", () => {
  // ULA (fc00::/7)
  expect(denyReasonForTarget({ host: "fc00::1", port: 443 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "fd00::1", port: 443 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "fdff::1", port: 443 })).toEqual(
    "blocked-private-ip",
  );
  // Link-local (fe80::/10)
  expect(denyReasonForTarget({ host: "fe80::1", port: 443 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "febf::1", port: 443 })).toEqual(
    "blocked-private-ip",
  );
  // Loopback
  expect(denyReasonForTarget({ host: "::1", port: 443 })).toEqual(
    "blocked-private-ip",
  );
  // Public addresses should pass
  expect(
    denyReasonForTarget({ host: "2001:4860:4860::8888", port: 443 }),
  ).toEqual(null);
  // fec0:: is NOT link-local (outside fe80::/10)
  expect(denyReasonForTarget({ host: "fec0::1", port: 443 })).toEqual(null);
});

test("matchesPathPrefix: exact match", () => {
  expect(matchesPathPrefix("/api", "/api")).toBe(true);
});

test("matchesPathPrefix: segment boundary with slash", () => {
  expect(matchesPathPrefix("/api/users", "/api")).toBe(true);
});

test("matchesPathPrefix: segment boundary with query string", () => {
  expect(matchesPathPrefix("/api?key=1", "/api")).toBe(true);
});

test("matchesPathPrefix: rejects non-segment-boundary match", () => {
  expect(matchesPathPrefix("/apiv2", "/api")).toBe(false);
});

test("matchesPathPrefix: trailing slash in prefix", () => {
  expect(matchesPathPrefix("/api/users", "/api/")).toBe(true);
});

test("matchesPathPrefix: no match at all", () => {
  expect(matchesPathPrefix("/other", "/api")).toBe(false);
});
