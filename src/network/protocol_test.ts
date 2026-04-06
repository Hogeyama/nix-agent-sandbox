import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeProxyAuthorization,
  denyReasonForTarget,
  matchesAllowlist,
  normalizeHost,
  normalizeTarget,
  parseAllowlistEntry,
} from "./protocol.ts";

Deno.test("decodeProxyAuthorization: decodes Basic credentials", () => {
  const header = `Basic ${btoa("sess_abc:tok_xyz")}`;
  assertEquals(decodeProxyAuthorization(header), {
    sessionId: "sess_abc",
    token: "tok_xyz",
  });
});

Deno.test("decodeProxyAuthorization: rejects malformed credentials", () => {
  assertEquals(decodeProxyAuthorization("Bearer token"), null);
  assertEquals(decodeProxyAuthorization(`Basic ${btoa("sess_only:")}`), null);
  assertEquals(decodeProxyAuthorization("Basic !!!"), null);
});

Deno.test("normalizeTarget: parses CONNECT authority", () => {
  const target = normalizeTarget({
    method: "CONNECT",
    authority: "api.openai.com:443",
  });
  assertEquals(target, { host: "api.openai.com", port: 443 });
});

Deno.test("normalizeTarget: parses absolute URI", () => {
  const target = normalizeTarget({
    method: "GET",
    url: "https://example.com/path",
  });
  assertEquals(target, { host: "example.com", port: 443 });
});

Deno.test("normalizeTarget: CONNECT requires an explicit port", () => {
  assertThrows(
    () =>
      normalizeTarget({
        method: "CONNECT",
        authority: "api.openai.com",
      }),
    Error,
    "explicit port",
  );
});

Deno.test("normalizeTarget: falls back to authority when URL is invalid", () => {
  const target = normalizeTarget({
    method: "GET",
    url: "not a valid url",
    hostHeader: "Example.COM.",
  });
  assertEquals(target, { host: "example.com", port: 80 });
});

Deno.test("normalizeHost: trims brackets, dots, and case", () => {
  assertEquals(normalizeHost("[2001:db8::1]"), "2001:db8::1");
  assertEquals(normalizeHost("Example.COM..."), "example.com");
});

Deno.test("parseAllowlistEntry: parses host only", () => {
  assertEquals(parseAllowlistEntry("example.com"), {
    host: "example.com",
    port: null,
  });
  assertEquals(parseAllowlistEntry("*.example.com"), {
    host: "*.example.com",
    port: null,
  });
});

Deno.test("parseAllowlistEntry: parses host:port", () => {
  assertEquals(parseAllowlistEntry("example.com:443"), {
    host: "example.com",
    port: 443,
  });
  assertEquals(parseAllowlistEntry("*.example.com:8080"), {
    host: "*.example.com",
    port: 8080,
  });
});

Deno.test("parseAllowlistEntry: parses IPv6 with brackets", () => {
  assertEquals(parseAllowlistEntry("[2001:db8::1]"), {
    host: "[2001:db8::1]",
    port: null,
  });
  assertEquals(parseAllowlistEntry("[2001:db8::1]:443"), {
    host: "[2001:db8::1]",
    port: 443,
  });
});

Deno.test("matchesAllowlist: supports wildcard subdomains", () => {
  assertEquals(
    matchesAllowlist({ host: "api.github.com", port: 443 }, ["*.github.com"]),
    true,
  );
  assertEquals(
    matchesAllowlist({ host: "github.com", port: 443 }, ["*.github.com"]),
    true,
  );
  assertEquals(
    matchesAllowlist({ host: "gitlab.com", port: 443 }, ["*.github.com"]),
    false,
  );
});

Deno.test("matchesAllowlist: port-qualified entries", () => {
  assertEquals(
    matchesAllowlist({ host: "example.com", port: 443 }, ["example.com:443"]),
    true,
  );
  assertEquals(
    matchesAllowlist({ host: "example.com", port: 80 }, ["example.com:443"]),
    false,
  );
  assertEquals(
    matchesAllowlist({ host: "example.com", port: 80 }, ["example.com"]),
    true,
  );
  assertEquals(
    matchesAllowlist({ host: "api.example.com", port: 443 }, [
      "*.example.com:443",
    ]),
    true,
  );
  assertEquals(
    matchesAllowlist({ host: "api.example.com", port: 80 }, [
      "*.example.com:443",
    ]),
    false,
  );
});

Deno.test("denyReasonForTarget: blocks localhost and RFC1918", () => {
  assertEquals(
    denyReasonForTarget({ host: "localhost", port: 80 }),
    "blocked-special-host",
  );
  assertEquals(
    denyReasonForTarget({ host: "10.0.0.1", port: 443 }),
    "blocked-private-ip",
  );
  assertEquals(
    denyReasonForTarget({ host: "127.0.0.1", port: 80 }),
    "blocked-private-ip",
  );
  assertEquals(
    denyReasonForTarget({ host: "172.16.0.1", port: 80 }),
    "blocked-private-ip",
  );
  assertEquals(
    denyReasonForTarget({ host: "172.31.255.255", port: 80 }),
    "blocked-private-ip",
  );
  assertEquals(
    denyReasonForTarget({ host: "192.168.1.1", port: 80 }),
    "blocked-private-ip",
  );
  assertEquals(
    denyReasonForTarget({ host: "169.254.0.1", port: 80 }),
    "blocked-private-ip",
  );
  // Public addresses should pass
  assertEquals(denyReasonForTarget({ host: "example.com", port: 443 }), null);
  assertEquals(denyReasonForTarget({ host: "8.8.8.8", port: 443 }), null);
  assertEquals(
    denyReasonForTarget({ host: "172.32.0.1", port: 80 }),
    null,
  );
});

Deno.test("denyReasonForTarget: blocks private and link-local IPv6", () => {
  // ULA (fc00::/7)
  assertEquals(
    denyReasonForTarget({ host: "fc00::1", port: 443 }),
    "blocked-private-ip",
  );
  assertEquals(
    denyReasonForTarget({ host: "fd00::1", port: 443 }),
    "blocked-private-ip",
  );
  assertEquals(
    denyReasonForTarget({ host: "fdff::1", port: 443 }),
    "blocked-private-ip",
  );
  // Link-local (fe80::/10)
  assertEquals(
    denyReasonForTarget({ host: "fe80::1", port: 443 }),
    "blocked-private-ip",
  );
  assertEquals(
    denyReasonForTarget({ host: "febf::1", port: 443 }),
    "blocked-private-ip",
  );
  // Loopback
  assertEquals(
    denyReasonForTarget({ host: "::1", port: 443 }),
    "blocked-private-ip",
  );
  // Public addresses should pass
  assertEquals(
    denyReasonForTarget({ host: "2001:4860:4860::8888", port: 443 }),
    null,
  );
  // fec0:: is NOT link-local (outside fe80::/10)
  assertEquals(
    denyReasonForTarget({ host: "fec0::1", port: 443 }),
    null,
  );
});
