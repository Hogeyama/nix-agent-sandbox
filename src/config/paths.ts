/**
 * Shared constants for config file paths and content.
 *
 * Used by both config/init.ts and stages/worktree to keep
 * .nas/.gitignore content in sync.
 */

import * as path from "node:path";

/** Content written to .nas/.gitignore — ignore everything under .nas/. */
export const NAS_GITIGNORE_CONTENT = "*\n";

/** グローバル設定ディレクトリ（XDG_CONFIG_HOME を優先） */
export function getGlobalConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configBase =
    xdgConfigHome ?? path.join(process.env.HOME ?? "/", ".config");
  return path.join(configBase, "nas");
}
