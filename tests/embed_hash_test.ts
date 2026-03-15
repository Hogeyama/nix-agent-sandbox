import { assertEquals } from "@std/assert";
import { computeEmbedHash } from "../src/docker/client.ts";

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
        new URL("../src/docker/embed/", import.meta.url),
        ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"],
      ],
      [
        new URL("../src/docker/envoy/", import.meta.url),
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
    new URL("../src/docker/envoy/envoy.template.yaml", import.meta.url),
  );

  for (
    const fragment of [
      "0.0.0.0:15001",
      "envoy.filters.http.dynamic_forward_proxy",
      "envoy.filters.http.ext_authz",
      "timeout: 300s",
      "timeout: 0s",
      "pipe: { path: /nas-network/auth-router.sock }",
      "/authorize",
      "Proxy-Authorization",
      "Host",
      "x-request-id",
      "headers_to_add",
      "x-nas-original-method",
      "x-nas-original-authority",
      "x-nas-original-url",
    ]
  ) {
    assertEquals(template.includes(fragment), true);
  }
});
