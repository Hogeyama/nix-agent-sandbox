/**
 * Docker クライアント unit テスト（Docker daemon 不要）
 *
 * computeEmbedHash、runInteractiveCommand 等の pure な関数を検証する。
 * Docker daemon を使う integration テストは docker_client_integration_test.ts を参照。
 */

import { assertEquals } from "@std/assert";
import { computeEmbedHash } from "../src/docker/client.ts";
import {
  dockerImageExists,
  dockerIsRunning,
  dockerLogs,
  getImageLabel,
} from "../src/docker/client.ts";

// --- computeEmbedHash ---

Deno.test("computeEmbedHash: returns consistent hash", async () => {
  const hash1 = await computeEmbedHash();
  const hash2 = await computeEmbedHash();
  assertEquals(hash1, hash2);
});

Deno.test("computeEmbedHash: returns valid SHA-256 hex string", async () => {
  const hash = await computeEmbedHash();
  assertEquals(hash.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
});

// --- embed hash は全埋め込みファイルから計算される ---

Deno.test("computeEmbedHash: includes all embedded files", async () => {
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
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const actual = await computeEmbedHash();
  assertEquals(actual, expected);
});

// --- Docker daemon 不要のテスト ---
// これらの関数は Docker daemon がなくても graceful に false/null を返す

Deno.test("dockerImageExists: returns false for non-existing image", async () => {
  const exists = await dockerImageExists("no-such-image-xyz:never");
  assertEquals(exists, false);
});

Deno.test("getImageLabel: returns null for non-existing image", async () => {
  const label = await getImageLabel("no-such-image-xyz:never", "foo");
  assertEquals(label, null);
});

Deno.test("getImageLabel: returns null for non-existing label", async () => {
  const label = await getImageLabel("alpine:latest", "no.such.label.xyz");
  assertEquals(label, null);
});

Deno.test("dockerIsRunning: returns false for non-existing container", async () => {
  const result = await dockerIsRunning("no-such-container-xyz");
  assertEquals(result, false);
});

Deno.test("dockerLogs: returns fallback for non-existing container", async () => {
  const logs = await dockerLogs("no-such-container-xyz");
  assertEquals(logs, "(failed to retrieve container logs)");
});
