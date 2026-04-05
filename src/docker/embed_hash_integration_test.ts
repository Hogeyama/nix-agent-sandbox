import { assertEquals } from "@std/assert";
import { computeEmbedHash } from "./client.ts";

Deno.test("computeEmbedHash returns consistent hash", async () => {
  const hash1 = await computeEmbedHash();
  const hash2 = await computeEmbedHash();
  assertEquals(hash1, hash2);
  // SHA-256 hex is 64 chars
  assertEquals(hash1.length, 64);
});

Deno.test("computeEmbedHash matches embed and envoy assets", async () => {
  const parts: string[] = [];
  for (
    const [baseUrl, files] of [
      [
        new URL("./embed/", import.meta.url),
        ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"],
      ],
      [
        new URL("./envoy/", import.meta.url),
        ["envoy.template.yaml"],
      ],
    ] as const
  ) {
    for (const name of files) {
      parts.push(await Deno.readTextFile(new URL(name, baseUrl)));
    }
  }
  const data = new TextEncoder().encode(parts.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const expected = Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  assertEquals(await computeEmbedHash(), expected);
});

Deno.test("envoy template includes required proxy settings", async () => {
  const template = await Deno.readTextFile(
    new URL("./envoy/envoy.template.yaml", import.meta.url),
  );

  for (
    const fragment of [
      "0.0.0.0:15001",
      "envoy.filters.http.dynamic_forward_proxy",
      "envoy.filters.http.lua",
      "request_timeout: 0s",
      "timeout: 0s",
      "access_log:",
      "envoy.access_loggers.stdout",
      "pipe: { path: /nas-network/auth-router.sock }",
      "/authorize",
      "proxy-authorization",
      "host",
      "x-request-id",
      "x-nas-original-method",
      "x-nas-original-authority",
      "x-nas-original-url",
      "300000",
      'handle:headers():remove("proxy-authorization")',
    ]
  ) {
    assertEquals(template.includes(fragment), true);
  }
});
