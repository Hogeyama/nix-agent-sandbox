import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ProtectedClaudeState } from "../../agents/types.ts";

// Only these entries within ~/.claude may be modified on the host.
export const CLAUDE_SHARED_DIRECTORIES = ["projects", "file-history"] as const;
export const CLAUDE_SHARED_FILES = [
  ".credentials.json",
  "history.jsonl",
] as const;

// These are runtime data, not host configuration. Start fresh in the private root.
const PRIVATE_ENTRIES = new Set([
  "backups",
  "cache",
  "debug",
  "paste-cache",
  "image-cache",
  "uploads",
  "session-env",
  "tasks",
  "shell-snapshots",
  "sessions",
  "plans",
  "todos",
  "statsig",
  "logs",
  "stats-cache.json",
  "remote-settings.json",
  "policy-limits.json",
  "policy-limits.json.stamp.json",
  "feedback-bundles",
  "feedback",
  "usage-data",
  "jobs",
  "daemon",
  "ide",
]);

async function ensureSharedPath(
  file: string,
  directory: boolean,
): Promise<void> {
  try {
    if (directory) await mkdir(file, { mode: 0o700 });
    else
      await writeFile(
        file,
        path.basename(file).endsWith(".json") ? "{}\n" : "",
        {
          flag: "wx",
          mode: 0o600,
        },
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(file);
  // A writable symlink could grant access to an unrelated host file or directory.
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(
      `[nas] Claude shared state must be a ${directory ? "directory" : "regular file"}: ${file}`,
    );
  }
}

/** Prepare bind sources without copying credentials or executing host configuration. */
export async function prepareProtectedClaudeState(
  hostHome: string,
): Promise<ProtectedClaudeState> {
  const claudeDir = path.join(hostHome, ".claude");
  const claudeJson = path.join(hostHome, ".claude.json");
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await ensureSharedPath(claudeJson, false);
  for (const name of CLAUDE_SHARED_DIRECTORIES)
    await ensureSharedPath(path.join(claudeDir, name), true);
  for (const name of CLAUDE_SHARED_FILES)
    await ensureSharedPath(path.join(claudeDir, name), false);

  const writable = new Set<string>([
    ...CLAUDE_SHARED_DIRECTORIES,
    ...CLAUDE_SHARED_FILES,
  ]);
  const entries = (await readdir(claudeDir))
    .sort()
    .filter((name) => !PRIVATE_ENTRIES.has(name))
    .map((name) => ({
      source: path.join(claudeDir, name),
      name,
      readOnly: !writable.has(name),
    }));
  // Keep the parent writable: Claude creates sibling temporary files before
  // replacing credentials, then falls back to in-place writes for bind mounts.
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-claude-state-"));
  return { runtimeDir, claudeJson, entries };
}

export async function removeProtectedClaudeState(
  state: ProtectedClaudeState,
): Promise<void> {
  await rm(state.runtimeDir, { recursive: true, force: true });
}
