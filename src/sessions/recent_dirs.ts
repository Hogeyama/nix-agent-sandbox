/**
 * Persistent "recent directories" list for the New Session dialog.
 *
 * Stored as a plain JSON array at `$XDG_STATE_HOME/nas/recent_dirs.json`
 * (fallback `$HOME/.local/state/nas/recent_dirs.json`). MRU-ordered,
 * capped to {@link RECENT_DIRS_MAX} entries. This is intentionally
 * separate from the runtime session store: recent dirs survive session
 * teardown and process restart, and the value recorded is the user's
 * launch cwd — not the worktree path a session happens to resolve to.
 *
 * Tests can override the storage path via `NAS_RECENT_DIRS_FILE`.
 */

import * as path from "node:path";
import { atomicWriteJson, readJsonFile } from "../lib/fs_utils.ts";

export const RECENT_DIRS_MAX = 20;

export function resolveRecentDirsFile(): string {
  const override = process.env.NAS_RECENT_DIRS_FILE;
  if (override && override.trim().length > 0) return override;

  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState && xdgState.trim().length > 0) {
    return path.join(xdgState, "nas", "recent_dirs.json");
  }
  const home = process.env.HOME;
  if (!home) {
    throw new Error(
      "Cannot resolve recent dirs file: neither XDG_STATE_HOME nor HOME is set",
    );
  }
  return path.join(home, ".local/state", "nas", "recent_dirs.json");
}

export async function readRecentDirs(filePath?: string): Promise<string[]> {
  const target = filePath ?? resolveRecentDirsFile();
  const raw = await readJsonFile<unknown>(target);
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

export async function addRecentDir(
  cwd: string,
  filePath?: string,
): Promise<void> {
  const target = filePath ?? resolveRecentDirsFile();
  const existing = await readRecentDirs(target);
  const filtered = existing.filter((d) => d !== cwd);
  filtered.unshift(cwd);
  if (filtered.length > RECENT_DIRS_MAX) filtered.length = RECENT_DIRS_MAX;
  await atomicWriteJson(target, filtered);
}
