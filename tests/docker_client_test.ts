/**
 * E2E tests: Docker クライアントとビルドステージ
 *
 * computeEmbedHash、DockerBuildStage の embed hash チェックロジックなどを検証する。
 */

import { assertEquals } from "@std/assert";
import { computeEmbedHash } from "../src/docker/client.ts";
import { DockerBuildStage } from "../src/stages/launch.ts";

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

Deno.test("computeEmbedHash: hash is not empty", async () => {
  const hash = await computeEmbedHash();
  assertEquals(hash.length > 0, true);
  assertEquals(
    hash !==
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    true,
  ); // SHA-256 of empty string
});

// --- DockerBuildStage constants ---

Deno.test("DockerBuildStage: EMBED_HASH_LABEL is set", () => {
  assertEquals(DockerBuildStage.EMBED_HASH_LABEL, "nas.embed-hash");
});

// --- 埋め込みファイルの存在確認 ---

Deno.test("Embedded Dockerfile exists and is readable", async () => {
  const baseUrl = new URL("../src/docker/embed/Dockerfile", import.meta.url);
  const content = await Deno.readTextFile(baseUrl);
  assertEquals(content.length > 0, true);
  assertEquals(content.includes("FROM"), true);
});

Deno.test("Embedded entrypoint.sh exists and is readable", async () => {
  const baseUrl = new URL("../src/docker/embed/entrypoint.sh", import.meta.url);
  const content = await Deno.readTextFile(baseUrl);
  assertEquals(content.length > 0, true);
  assertEquals(content.includes("#!/"), true);
});

Deno.test("Embedded osc52-clip.sh exists and is readable", async () => {
  const baseUrl = new URL(
    "../src/docker/embed/osc52-clip.sh",
    import.meta.url,
  );
  const content = await Deno.readTextFile(baseUrl);
  assertEquals(content.length > 0, true);
});

// --- embed hash は全埋め込みファイルから計算される ---

Deno.test("computeEmbedHash: includes all embedded files", async () => {
  // ハッシュが Dockerfile + entrypoint.sh + osc52-clip.sh から計算されることを検証
  // 各ファイルの内容を読み取って手動でハッシュを計算し、computeEmbedHash と比較
  const baseUrl = new URL("../src/docker/embed/", import.meta.url);
  const parts: string[] = [];
  for (const name of ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"]) {
    parts.push(await Deno.readTextFile(new URL(name, baseUrl)));
  }
  const data = new TextEncoder().encode(parts.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const expected = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const actual = await computeEmbedHash();
  assertEquals(actual, expected);
});
