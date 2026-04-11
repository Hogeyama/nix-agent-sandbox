import { expect, test } from "bun:test";
import {
  decodeProxyAuthorization,
  denyReasonForTarget,
  matchesAllowlist,
  normalizeHost,
  normalizeTarget,
  parseAllowlistEntry,
} from "./protocol.ts";

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

test("matchesAllowlist: supports wildcard subdomains", () => {
  expect(
    matchesAllowlist({ host: "api.github.com", port: 443 }, ["*.github.com"]),
  ).toEqual(true);
  expect(
    matchesAllowlist({ host: "github.com", port: 443 }, ["*.github.com"]),
  ).toEqual(true);
  expect(
    matchesAllowlist({ host: "gitlab.com", port: 443 }, ["*.github.com"]),
  ).toEqual(false);
});

test("matchesAllowlist: port-qualified entries", () => {
  expect(
    matchesAllowlist({ host: "example.com", port: 443 }, ["example.com:443"]),
  ).toEqual(true);
  expect(
    matchesAllowlist({ host: "example.com", port: 80 }, ["example.com:443"]),
  ).toEqual(false);
  expect(
    matchesAllowlist({ host: "example.com", port: 80 }, ["example.com"]),
  ).toEqual(true);
  expect(
    matchesAllowlist({ host: "api.example.com", port: 443 }, [
      "*.example.com:443",
    ]),
  ).toEqual(true);
  expect(
    matchesAllowlist({ host: "api.example.com", port: 80 }, [
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
