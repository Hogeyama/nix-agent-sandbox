import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
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

async function isExistingSymlink(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function ensureFileCreated(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Prepare bind sources for a session-private Claude state root: entries
 * under `~/.claude` are exposed individually instead of bind-mounting the
 * directory itself, so the caller can mount something else (a dummy
 * credentials file) in place of one specific entry without that mount
 * living inside a read-write bind of the host directory.
 *
 * `protectSettings` (default true) is "protected mode": configuration
 * stays read-only, `PRIVATE_ENTRIES` are left out entirely (fresh in the
 * private root), and only `CLAUDE_SHARED_DIRECTORIES` / `CLAUDE_SHARED_FILES`
 * are writable. `protectSettings: false` exposes every entry read-write
 * with nothing excluded, matching a direct read-write bind of `~/.claude`;
 * this is the layout used when Claude's credentials are proxied but
 * `protectSettings` itself was not requested.
 *
 * `shareCredentials` (default true) controls `.credentials.json`
 * specifically: `false` neither creates nor exposes it, for callers that
 * mount a dummy credentials file in its place.
 *
 * A top-level entry that is a symlink is never bind-mounted: Docker
 * resolves a bind source on the host, so mounting a symlink would expose
 * whatever it points to — possibly outside `~/.claude` — at that host
 * path, rather than resolving inside the container's own filesystem
 * namespace. With `protectSettings: false` (where such an entry would
 * otherwise be bound read-write), the symlink itself is replicated into
 * the private root, so it resolves in the container's namespace. The
 * known shared paths (`CLAUDE_SHARED_DIRECTORIES`, `CLAUDE_SHARED_FILES`)
 * follow the same rule when they are symlinks: they are replicated like
 * any other entry rather than failing the regular-file/directory check
 * that applies under `protectSettings: true`.
 *
 * `~/.claude.json` sits outside `~/.claude` and is bound on its own, not
 * through the private root. With `protectSettings: false` it is created if
 * missing and bound as-is even when it is a symlink, so the container
 * reads and writes the same file the host's Claude Code uses as its
 * `~/.claude.json`. With `protectSettings: true` it must be a regular
 * file.
 */
export async function prepareProtectedClaudeState(
  hostHome: string,
  options: { shareCredentials?: boolean; protectSettings?: boolean } = {},
): Promise<ProtectedClaudeState> {
  const protectSettings = options.protectSettings !== false;
  const shareCredentials = options.shareCredentials !== false;
  const claudeDir = path.join(hostHome, ".claude");
  const claudeJson = path.join(hostHome, ".claude.json");
  const sharedFiles = CLAUDE_SHARED_FILES.filter(
    (name) => shareCredentials || name !== ".credentials.json",
  );
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });
  if (protectSettings) {
    await ensureSharedPath(claudeJson, false);
  } else {
    // Bound as-is even when it is a symlink; see the doc comment above.
    await ensureFileCreated(claudeJson, "{}\n");
  }
  for (const name of CLAUDE_SHARED_DIRECTORIES) {
    const target = path.join(claudeDir, name);
    if (!protectSettings && (await isExistingSymlink(target))) continue;
    await ensureSharedPath(target, true);
  }
  for (const name of sharedFiles) {
    const target = path.join(claudeDir, name);
    if (!protectSettings && (await isExistingSymlink(target))) continue;
    await ensureSharedPath(target, false);
  }

  const writable = new Set<string>([
    ...CLAUDE_SHARED_DIRECTORIES,
    ...sharedFiles,
  ]);
  const names = (await readdir(claudeDir))
    .sort()
    .filter((name) => !protectSettings || !PRIVATE_ENTRIES.has(name))
    .filter((name) => shareCredentials || name !== ".credentials.json");

  // Keep the parent writable: Claude creates sibling temporary files before
  // replacing credentials, then falls back to in-place writes for bind mounts.
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-claude-state-"));

  type Entry = ProtectedClaudeState["entries"][number];
  const entries: Entry[] = [];
  try {
    for (const name of names) {
      const source = path.join(claudeDir, name);
      if (!protectSettings && (await isExistingSymlink(source))) {
        const linkTarget = await readlink(source);
        await symlink(linkTarget, path.join(runtimeDir, name));
        continue;
      }
      entries.push({
        source,
        name,
        readOnly: protectSettings && !writable.has(name),
      });
    }
  } catch (error) {
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }
  return { runtimeDir, claudeJson, entries };
}

export async function removeProtectedClaudeState(
  state: ProtectedClaudeState,
): Promise<void> {
  await rm(state.runtimeDir, { recursive: true, force: true });
}
