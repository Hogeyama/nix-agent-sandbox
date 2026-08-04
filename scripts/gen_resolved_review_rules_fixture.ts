#!/usr/bin/env bun
/**
 * `src/network/fixtures/resolved_review_rules/anthropic-v1.json` の生成器。
 *
 * fixture は addon (Python) / broker (TS) / 統合テストが**同じ出荷物**を見て
 * いることを担保するためのもので、権威は `src/config/Schema.pkl` の
 * `anthropicV1()` にある。手で維持すると pkl 側と黙って乖離するので、
 * ここで pkl → loadConfig → resolveReviewRules の実経路を通して生成する。
 *
 *   bun run scripts/gen_resolved_review_rules_fixture.ts
 *
 * 同じ関数を `src/config/pkl_integration_test.ts` が呼び、コミット済みの
 * fixture と一致することを検証している。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import {
  type ResolvedReviewRules,
  resolveReviewRules,
} from "../src/network/review_rules.ts";

export const FIXTURE_PATH =
  "src/network/fixtures/resolved_review_rules/anthropic-v1.json";

/**
 * リポジトリ内の Schema.pkl。`resolveSchemaAsset()` は `NAS_ASSET_DIR` が
 * 立っていると**インストール済み**の nas アセットを指すので使わない。
 * (nas セッションの中で開発しているときは常にそうなる)
 */
const REPO_SCHEMA_PKL = fileURLToPath(
  new URL("../src/config/Schema.pkl", import.meta.url),
);

const CONFIG_PKL = `amends "Schema.pkl"

profiles {
  ["fixture"] {
    agent = "claude"
    mask = new MaskConfig {
      proxy = true
    }
    network {
      reviewRules {
        for (r in module.anthropicV1("anthropic", "api.anthropic.com")) { r }
      }
    }
  }
}
`;

const PKL_PROJECT = `amends "pkl:Project"

evaluatorSettings {
  modulePath {
    "."
  }
}
`;

/**
 * Schema.pkl の `anthropicV1("anthropic", "api.anthropic.com")` を実際の
 * pkl 評価 + loadConfig 経由で解決し、runtime contract を返す。
 *
 * `loadConfig` は評価前に `.nas/Schema.pkl` をアセットから上書きするため、
 * リポジトリの Schema.pkl を指す一時アセットツリーを `NAS_ASSET_DIR` で
 * 差し込んで hermetic にする。
 */
export async function generateAnthropicV1Fixture(): Promise<ResolvedReviewRules> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-fixture-"));
  try {
    const assetDir = path.join(tmpDir, "assets");
    await mkdir(path.join(assetDir, "config"), { recursive: true });
    const schemaText = await Bun.file(REPO_SCHEMA_PKL).text();
    await writeFile(path.join(assetDir, "config", "Schema.pkl"), schemaText);

    const projectDir = path.join(tmpDir, "project");
    const nasDir = path.join(projectDir, ".nas");
    await mkdir(nasDir, { recursive: true });
    await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);
    await writeFile(path.join(nasDir, "PklProject"), PKL_PROJECT);
    await writeFile(path.join(nasDir, "config.pkl"), CONFIG_PKL);

    // 使い捨ての temp config を自分で書いているので trust ゲートは通す。
    // (テストからは preload が同じ変数を立てている)
    const config = await withEnv(
      { NAS_ASSET_DIR: assetDir, NAS_CONFIG_TRUST_ALL: "1" },
      () => loadConfig({ startDir: projectDir }),
    );
    return resolveReviewRules(config.profiles.fixture.network.reviewRules);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function withEnv<T>(
  overrides: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

if (import.meta.main) {
  const resolved = await generateAnthropicV1Fixture();
  const target = path.join(import.meta.dir, "..", FIXTURE_PATH);
  await writeFile(target, `${JSON.stringify(resolved, null, 2)}\n`);
  console.log(`wrote ${FIXTURE_PATH} (${resolved.rules.length} rules)`);
}
