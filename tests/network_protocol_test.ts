import { assertEquals } from "@std/assert";
import {
  decodeProxyAuthorization,
  isDenyByDefaultTarget,
  normalizeTarget,
} from "../src/network/protocol.ts";

Deno.test("normalizeTarget: CONNECT authority is normalized", () => {
  assertEquals(
    normalizeTarget({
      method: "CONNECT",
      authority: "API.OpenAI.com.:443",
    }),
    { host: "api.openai.com", port: 443 },
  );
});

Deno.test("normalizeTarget: forward request prefers absolute URI", () => {
  assertEquals(
    normalizeTarget({
      method: "GET",
      url: "https://Example.COM/v1/models",
      host: "ignored.example.com",
    }),
    { host: "example.com", port: 443 },
  );
});

Deno.test("normalizeTarget: Host fallback uses default http port", () => {
  assertEquals(
    normalizeTarget({
      method: "GET",
      url: "/relative",
      host: "registry.npmjs.org",
    }),
    { host: "registry.npmjs.org", port: 80 },
  );
});

Deno.test("normalizeTarget: invalid authority returns null", () => {
  assertEquals(
    normalizeTarget({
      method: "CONNECT",
      authority: "example.com/path:443",
    }),
    null,
  );
  assertEquals(
    normalizeTarget({
      method: "GET",
      host: "example.com:0",
    }),
    null,
  );
});

Deno.test("isDenyByDefaultTarget: blocks local and private destinations", () => {
  assertEquals(isDenyByDefaultTarget({ host: "localhost", port: 80 }), true);
  assertEquals(
    isDenyByDefaultTarget({ host: "metadata.google.internal", port: 80 }),
    true,
  );
  assertEquals(isDenyByDefaultTarget({ host: "127.0.0.1", port: 80 }), true);
  assertEquals(
    isDenyByDefaultTarget({ host: "192.168.1.10", port: 443 }),
    true,
  );
  assertEquals(isDenyByDefaultTarget({ host: "fd00::1", port: 443 }), true);
  assertEquals(
    isDenyByDefaultTarget({ host: "api.openai.com", port: 443 }),
    false,
  );
});

Deno.test("decodeProxyAuthorization: decodes basic credentials", () => {
  assertEquals(
    decodeProxyAuthorization("Basic c2Vzc18xMjM6dG9rZW4tYWJj"),
    { sessionId: "sess_123", token: "token-abc" },
  );
  assertEquals(decodeProxyAuthorization("Bearer abc"), null);
  assertEquals(decodeProxyAuthorization("Basic !!!"), null);
});
