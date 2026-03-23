import * as path from "@std/path";
import { logInfo } from "../log.ts";
import {
  defaultRuntimeDir,
  ensureDir,
  isPidAlive,
  readPid,
} from "../lib/fs_utils.ts";

export interface DbusRuntimePaths {
  runtimeDir: string;
  sessionsDir: string;
}

export interface DbusSessionPaths {
  sessionDir: string;
  socketPath: string;
  pidFile: string;
}

export async function resolveDbusRuntimePaths(
  runtimeDir?: string,
): Promise<DbusRuntimePaths> {
  const resolved = runtimeDir ?? defaultRuntimeDir("dbus");
  const paths: DbusRuntimePaths = {
    runtimeDir: resolved,
    sessionsDir: path.join(resolved, "sessions"),
  };
  await ensureDir(paths.runtimeDir, 0o755);
  await ensureDir(paths.sessionsDir);
  return paths;
}

export function resolveDbusSessionPaths(
  runtimePaths: DbusRuntimePaths,
  sessionId: string,
): DbusSessionPaths {
  const sessionDir = path.join(runtimePaths.sessionsDir, sessionId);
  return {
    sessionDir,
    socketPath: path.join(sessionDir, "bus"),
    pidFile: path.join(sessionDir, "proxy.pid"),
  };
}

export async function gcDbusRuntime(
  runtimePaths: DbusRuntimePaths,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(runtimePaths.sessionsDir)) {
      if (!entry.isDirectory) continue;
      const sessionDir = path.join(runtimePaths.sessionsDir, entry.name);
      const pidFile = path.join(sessionDir, "proxy.pid");
      const pid = await readPid(pidFile);
      const alive = pid !== null && await isPidAlive(pid);
      if (alive) continue;
      await Deno.remove(sessionDir, { recursive: true }).catch((e) =>
        logInfo(`[nas] DbusRegistry GC: failed to remove session dir: ${e}`)
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
