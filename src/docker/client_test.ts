/**
 * Docker クライアント unit テスト（Docker daemon 不要）
 *
 * Docker daemon がなくても graceful に動く関数を検証する。
 * ファイル読み込みが必要な computeEmbedHash テストは embed_hash_integration_test.ts、
 * Docker daemon を使うテストは client_integration_test.ts を参照。
 */

import { assertEquals } from "@std/assert";
import {
  dockerImageExists,
  dockerIsRunning,
  dockerLogs,
  getImageLabel,
} from "./client.ts";

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
