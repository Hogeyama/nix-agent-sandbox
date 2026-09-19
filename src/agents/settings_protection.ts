/**
 * ホストのエージェント設定ファイルを読み取り専用で渡すための共通部品。
 *
 * Codex / Copilot の RW 状態ディレクトリにある設定ファイルを保護する。
 * Claude の保護は mount/claude_state_fs.ts で認証・履歴と設定類を分けて行う。
 *
 * 状態ディレクトリを RW でバインドしたうえで、設定ファイルだけを RO の
 * file bind mount で上乗せする。Linux では bind mount の target は
 * mount point 扱いになり、親ディレクトリが書き込み可能でも
 * unlink/rename/open(O_WRONLY) がすべて拒否される。`.nas/config.pkl` も
 * 同じ手段で守っている (`src/stages/mount/stage.ts`)。
 *
 * 守るのはユーザ単位の設定だけである。ワークスペース内の
 * `.claude/settings.json` や `.git/hooks` はエージェントが編集する対象と
 * 同じツリーにあるため、ここでは扱わない。
 */

import { statSync } from "node:fs";
import * as path from "node:path";
import type { MountSpec } from "../pipeline/state.ts";

/** `~/.claude` 配下で RO 化する設定ファイル (状態ディレクトリからの相対パス)。 */
export const CLAUDE_SETTINGS_FILES: readonly string[] = [
  "settings.json",
  "settings.local.json",
];

/** `~/.codex` 配下で RO 化する設定ファイル。 */
export const CODEX_SETTINGS_FILES: readonly string[] = ["config.toml"];

/** `~/.copilot` 配下で RO 化する設定ファイル。 */
export const COPILOT_SETTINGS_FILES: readonly string[] = [
  "config.json",
  "mcp-config.json",
];

/**
 * 実在する設定ファイルだけを相対パスで返す (副作用あり)。
 *
 * 存在しないパスを bind mount のソースにすると Docker がホスト側に root 所有の
 * 空ディレクトリを作ってしまい、エージェントが同じ名前のファイルを作れなくなる。
 * まだ設定ファイルを持たないホストでは、単に守る対象が無いものとして扱う。
 */
export function existingSettingsFiles(
  hostStateDir: string,
  candidates: readonly string[],
): readonly string[] {
  return candidates.filter((relPath) => {
    try {
      return statSync(path.join(hostStateDir, relPath)).isFile();
    } catch {
      return false;
    }
  });
}

/** 設定ファイルを RO で上乗せする `docker run -v` 引数を組み立てる。 */
export function settingsMountArgs(
  hostStateDir: string,
  containerStateDir: string,
  relPaths: readonly string[],
): string[] {
  return relPaths.flatMap((relPath) => [
    "-v",
    `${hostStateDir}/${relPath}:${containerStateDir}/${relPath}:ro`,
  ]);
}

/**
 * 同じ RO マウントを構造化した `MountSpec` として返す。
 *
 * `-v` の文字列は `:` で区切るため、`:` を含むホストパスを表現できない。
 * Compose を使う IDE 経路はこちらを使う。
 */
export function settingsMountSpecs(
  hostStateDir: string,
  containerStateDir: string,
  relPaths: readonly string[],
): MountSpec[] {
  return relPaths.map((relPath) => ({
    source: path.join(hostStateDir, relPath),
    target: `${containerStateDir}/${relPath}`,
    readOnly: true,
  }));
}
