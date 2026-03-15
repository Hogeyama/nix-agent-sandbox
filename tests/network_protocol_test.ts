import { assertEquals } from "@std/assert";
import {
  decodeProxyAuthorization,
  denyReasonForTarget,
  matchesAllowlist,
  normalizeTarget,
} from "../src/network/protocol.ts";

Deno.test("decodeProxyAuthorization: decodes Basic credentials", () => {
  const header = `Basic ${btoa("sess_abc:tok_xyz")}`;
  assertEquals(decodeProxyAuthorization(header), {
    sessionId: "sess_abc",
    token: "tok_xyz",
  });
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

Deno.test("matchesAllowlist: supports wildcard subdomains", () => {
  assertEquals(matchesAllowlist("api.github.com", ["*.github.com"]), true);
  assertEquals(matchesAllowlist("github.com", ["*.github.com"]), true);
  assertEquals(matchesAllowlist("gitlab.com", ["*.github.com"]), false);
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
  assertEquals(denyReasonForTarget({ host: "example.com", port: 443 }), null);
});
