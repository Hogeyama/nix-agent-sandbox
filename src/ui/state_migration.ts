/**
 * One-shot migration of UI daemon state from `$XDG_CACHE_HOME/nas/ui` into
 * the canonical `$XDG_STATE_HOME/nas/ui` directory.
 *
 * Invoked once at the top of the `nas ui` start path (never on the `stop`
 * path, never on hot read paths). Idempotent: if the destination already
 * holds a `daemon.json`, the helper returns without touching either side.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isUiDaemonRunning } from "./daemon.ts";
import {
  daemonLogPath,
  daemonStateDir,
  daemonStatePath,
  daemonTokenPath,
} from "./paths.ts";

export type MigrationOutcome =
  | { kind: "noop" }
  | { kind: "migrated"; movedFiles: string[] }
  | { kind: "skipped-new-exists" }
  | { kind: "skipped-token-failure" };

export interface MigrationDeps {
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  copyFile?: (src: string, dest: string, mode?: number) => Promise<void>;
  chmod?: (p: string, mode: number) => Promise<void>;
  unlink?: (p: string) => Promise<void>;
  isLegacyDaemonAlive?: (port: number) => Promise<boolean>;
  log?: (msg: string) => void;
}

interface FileSpec {
  basename: string;
  newPath: string;
  mode: number;
  isToken: boolean;
}

function resolveLegacyCacheDir(): string {
  const xdgCache =
    process.env.XDG_CACHE_HOME ||
    path.join(process.env.HOME ?? "/tmp", ".cache");
  return path.join(xdgCache, "nas", "ui");
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return false;
    throw err;
  }
}

export async function migrateLegacyUiState(
  deps: MigrationDeps = {},
): Promise<MigrationOutcome> {
  const rename = deps.rename ?? fs.rename;
  const copyFile = deps.copyFile ?? fs.copyFile;
  const chmod = deps.chmod ?? fs.chmod;
  const unlink = deps.unlink ?? fs.unlink;
  const isLegacyDaemonAlive = deps.isLegacyDaemonAlive ?? isUiDaemonRunning;
  const log = deps.log ?? ((msg: string) => console.warn(msg));

  const legacyDir = resolveLegacyCacheDir();
  const newDir = daemonStateDir();

  // 1. If the new daemon.json already exists, treat the migration as already done.
  if (await pathExists(daemonStatePath())) {
    if (await pathExists(legacyDir)) {
      log(
        `[nas] legacy UI state directory still present at ${legacyDir}; remove it manually if no longer needed`,
      );
    }
    return { kind: "skipped-new-exists" };
  }

  // 2. If the legacy dir does not exist at all, nothing to do.
  if (!(await pathExists(legacyDir))) {
    return { kind: "noop" };
  }

  // 3. Liveness check on the legacy daemon, if any state file is parsable.
  const legacyStatePath = path.join(legacyDir, "daemon.json");
  try {
    const raw = await fs.readFile(legacyStatePath, "utf8");
    const parsed = JSON.parse(raw) as { port?: unknown };
    if (typeof parsed.port === "number") {
      if (await isLegacyDaemonAlive(parsed.port)) {
        throw new Error(
          `legacy UI daemon is still running on port ${parsed.port} (legacy state at ${legacyDir}); run \`nas ui stop\` first to migrate state`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("legacy UI daemon")) {
      throw err;
    }
    if (errnoCode(err) === "ENOENT") {
      // No legacy daemon.json — nothing to liveness-check.
    } else {
      log(
        `[nas] could not read legacy daemon.json at ${legacyStatePath}; proceeding with migration: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // 4. Per-file move with EXDEV fallback.
  await fs.mkdir(newDir, { recursive: true });

  const files: FileSpec[] = [
    {
      basename: "daemon.json",
      newPath: daemonStatePath(),
      mode: 0o644,
      isToken: false,
    },
    {
      basename: "daemon.token",
      newPath: daemonTokenPath(),
      mode: 0o600,
      isToken: true,
    },
    {
      basename: "daemon.log",
      newPath: daemonLogPath(),
      mode: 0o644,
      isToken: false,
    },
  ];

  const movedFiles: string[] = [];

  for (const file of files) {
    const oldPath = path.join(legacyDir, file.basename);
    try {
      await rename(oldPath, file.newPath);
      movedFiles.push(file.basename);
      continue;
    } catch (err) {
      const code = errnoCode(err);
      if (code === "ENOENT") {
        // Source file did not exist; skip.
        continue;
      }
      if (code !== "EXDEV") {
        throw err;
      }
    }

    // EXDEV fallback: copy + chmod + unlink.
    try {
      await copyFile(oldPath, file.newPath, fsConstants.COPYFILE_EXCL);
      await chmod(file.newPath, file.mode);
      await unlink(oldPath);
      movedFiles.push(file.basename);
    } catch (fallbackErr) {
      if (file.isToken) {
        try {
          await unlink(file.newPath);
        } catch {
          // Best-effort rollback; preserve original failure.
        }
        log(
          "[nas] failed to migrate WS token; run `nas ui stop` and re-run `nas ui` to regenerate",
        );
        return { kind: "skipped-token-failure" };
      }
      log(
        `[nas] failed to migrate ${file.basename}: ${
          fallbackErr instanceof Error
            ? fallbackErr.message
            : String(fallbackErr)
        }`,
      );
    }
  }

  // 5. Best-effort cleanup of the now-empty legacy dir.
  try {
    await fs.rmdir(legacyDir);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT") {
      // already gone
    } else if (code === "ENOTEMPTY") {
      log(
        `[nas] legacy UI state directory ${legacyDir} still contains files; not removing`,
      );
    } else {
      throw err;
    }
  }

  if (movedFiles.length === 0) {
    return { kind: "noop" };
  }
  return { kind: "migrated", movedFiles };
}
