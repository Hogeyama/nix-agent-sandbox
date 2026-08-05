/**
 * テストが評価する Schema.pkl を、リポジトリのものに固定する。
 *
 * `loadConfig` は評価の前に `.nas/Schema.pkl` をアセットから上書きするので、
 * `NAS_ASSET_DIR` が**インストール済みの** nas を指していると (nas セッションの
 * 中で nas を開発しているときは常にそう)、リポジトリの Schema.pkl が一切検証
 * されないまま緑になる。スキーマを変えた変更が、古い出荷物に対して通っただけの
 * 緑を返してくる。
 */

import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * リポジトリの `config/` を持つアセットツリーを立て、`NAS_ASSET_DIR` を
 * そこに向ける。返り値を呼ぶと元に戻す。
 *
 * `config/` 以外 (Dockerfile やバイナリ) は元のアセットツリーへの symlink で
 * 済ませる。それらはこの差し替えの対象ではないうえ、欠けると「初期化できない」
 * という無関係な失敗に化けるためである。
 */
export async function useRepoSchemaAsset(): Promise<() => Promise<void>> {
  const assetDir = await mkdtemp(path.join(tmpdir(), "nas-schema-asset-"));
  const previous = process.env.NAS_ASSET_DIR;

  if (previous !== undefined) {
    for (const entry of await readdir(previous).catch(() => [])) {
      if (entry === "config") continue;
      await symlink(path.join(previous, entry), path.join(assetDir, entry));
    }
  }

  await mkdir(path.join(assetDir, "config"), { recursive: true });
  await writeFile(
    path.join(assetDir, "config", "Schema.pkl"),
    await readFile(new URL("./Schema.pkl", import.meta.url), "utf8"),
  );
  // 自動初期化はテンプレートも読むので、Schema.pkl だけでは足りない。
  await cp(
    fileURLToPath(new URL("./templates", import.meta.url)),
    path.join(assetDir, "config", "templates"),
    { recursive: true },
  );
  process.env.NAS_ASSET_DIR = assetDir;

  return async () => {
    if (previous === undefined) delete process.env.NAS_ASSET_DIR;
    else process.env.NAS_ASSET_DIR = previous;
    await rm(assetDir, { recursive: true, force: true });
  };
}
