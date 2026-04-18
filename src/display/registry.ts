/**
 * Display runtime registry — host-side tracking of live xpra sessions.
 *
 * Each nas session that enables xpra display sandboxing writes a JSON entry
 * here when `DisplayService.startXpra` succeeds, and removes it when the
 * pipeline scope closes. If nas crashes before the scope finalizer runs
 * (OOM, SIGKILL, power loss), the entry is left behind pointing at the
 * (now defunct) xpra server PID. `gcDisplayRuntime` detects these, kills
 * any stray attach process, and removes the stale session dir + X11 socket.
 *
 * Layout under `$XDG_RUNTIME_DIR/nas/display/`:
 *
 *   sessions/<sessionId>.json    registry entry (this module)
 *   <sessionId>/                 per-session runtime dir owned by
 *                                stages/display.ts (Xauthority, xpra.log, ...)
 *
 * The `sessions/` bucket is what GC walks; individual session dirs are
 * opened by the display stage at known paths. Both sit under the same
 * display runtime root so a single `rm -rf` removes everything the session
 * owned.
 */

import { readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  atomicWriteJson,
  defaultRuntimeDir,
  ensureDir,
  isPidAlive,
  readJsonDir,
  readJsonFile,
  safeRemove,
} from "../lib/fs_utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DisplayRuntimePaths {
  readonly runtimeDir: string;
  readonly sessionsDir: string;
}

export interface DisplayRegistryEntry {
  readonly sessionId: string;
  /** PID of the xpra *server* (the `xpra start :N` process). */
  readonly xpraServerPid: number;
  /** PID of the auto-launched `xpra attach :N` process. May be 0 if unknown. */
  readonly attachPid: number;
  /** Per-session runtime dir that display stage owns (`<runtimeDir>/<sessionId>`). */
  readonly sessionDir: string;
  readonly displayNumber: number;
  /** Xvfb socket created by xpra (e.g. `/tmp/.X11-unix/X100`). */
  readonly socketPath: string;
  readonly createdAt: string;
}

export interface DisplayGcResult {
  readonly removedSessions: string[];
  readonly removedSessionDirs: string[];
  readonly removedSockets: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Mirror of `runtime_registry.assertWithin` — defence-in-depth against a
 * malformed sessionId escaping the sessions directory via `..`.
 */
function assertWithin(base: string, joined: string): string {
  const rel = path.relative(base, joined);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path traversal detected: ${joined}`);
  }
  return joined;
}

export async function resolveDisplayRuntimePaths(
  runtimeDir?: string,
): Promise<DisplayRuntimePaths> {
  const resolved = runtimeDir ?? defaultRuntimeDir("display");
  const paths: DisplayRuntimePaths = {
    runtimeDir: resolved,
    sessionsDir: path.join(resolved, "sessions"),
  };
  await ensureDir(paths.runtimeDir, 0o700);
  await ensureDir(paths.sessionsDir, 0o700);
  return paths;
}

function sessionRegistryPath(
  paths: DisplayRuntimePaths,
  sessionId: string,
): string {
  return assertWithin(
    paths.sessionsDir,
    path.join(paths.sessionsDir, `${sessionId}.json`),
  );
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function writeDisplayRegistry(
  paths: DisplayRuntimePaths,
  entry: DisplayRegistryEntry,
): Promise<void> {
  await atomicWriteJson(sessionRegistryPath(paths, entry.sessionId), entry);
}

export async function readDisplayRegistry(
  paths: DisplayRuntimePaths,
  sessionId: string,
): Promise<DisplayRegistryEntry | null> {
  return await readJsonFile<DisplayRegistryEntry>(
    sessionRegistryPath(paths, sessionId),
  );
}

export async function listDisplayRegistries(
  paths: DisplayRuntimePaths,
): Promise<DisplayRegistryEntry[]> {
  return await readJsonDir<DisplayRegistryEntry>(paths.sessionsDir);
}

export async function removeDisplayRegistry(
  paths: DisplayRuntimePaths,
  sessionId: string,
): Promise<void> {
  await safeRemove(sessionRegistryPath(paths, sessionId));
}

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

/**
 * Scan the sessions directory and remove entries whose xpra server PID is
 * no longer alive. For each stale entry:
 *
 *   1. SIGTERM the attach pid (best-effort; likely already dead because
 *      `xpra attach` exits when the server dies).
 *   2. `rm -rf` the session dir — contains `xpra.log`, `Xauthority`, etc.
 *      that `stages/display.ts` creates under `<runtimeDir>/<sessionId>`.
 *   3. Remove the Xvfb socket at `socketPath`. Xpra normally unlinks this
 *      on clean shutdown; on SIGKILL it lingers and prevents the display
 *      number from being reused.
 *   4. Remove the registry file itself.
 *
 * Best-effort throughout: any individual step may fail (permission, ENOENT)
 * and we still advance to the next entry. The result reports what was
 * successfully removed so the caller can log it.
 */
export async function gcDisplayRuntime(
  paths: DisplayRuntimePaths,
): Promise<DisplayGcResult> {
  const removedSessions: string[] = [];
  const removedSessionDirs: string[] = [];
  const removedSockets: string[] = [];

  // Read entries one-by-one so a single corrupt JSON file doesn't abort
  // the whole GC pass — a stray write to the registry dir shouldn't
  // wedge future nas startups.
  const entries: DisplayRegistryEntry[] = [];
  let fileNames: string[] = [];
  try {
    fileNames = (await readdir(paths.sessionsDir)).filter((n) =>
      n.endsWith(".json"),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const fileName of fileNames) {
    try {
      const entry = await readJsonFile<DisplayRegistryEntry>(
        path.join(paths.sessionsDir, fileName),
      );
      if (entry) entries.push(entry);
    } catch {
      // Unparseable entry — leave the file alone, GC will try again next run.
    }
  }

  for (const entry of entries) {
    if (await isPidAlive(entry.xpraServerPid)) continue;

    if (entry.attachPid > 0) {
      try {
        process.kill(entry.attachPid, "SIGTERM");
      } catch {
        // ESRCH (already dead) / EPERM — nothing we can do.
      }
    }

    try {
      await safeRemove(entry.sessionDir, { recursive: true });
      removedSessionDirs.push(entry.sessionDir);
    } catch {
      // fall through; still try the rest
    }

    try {
      await safeRemove(entry.socketPath);
      removedSockets.push(entry.socketPath);
    } catch {
      // Xvfb socket may be owned by another uid if the session forked;
      // we can't rm it, but the registry entry still goes away.
    }

    await removeDisplayRegistry(paths, entry.sessionId);
    removedSessions.push(entry.sessionId);
  }

  return { removedSessions, removedSessionDirs, removedSockets };
}
