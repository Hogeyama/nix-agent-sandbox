import * as path from "@std/path";

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
  const resolved = runtimeDir ?? defaultRuntimeDir();
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
      await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function defaultRuntimeDir(): string {
  const xdg = Deno.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim() !== "") {
    return path.join(xdg, "nas", "dbus");
  }
  const uid = typeof Deno.uid === "function" ? Deno.uid() : "unknown";
  return path.join("/tmp", `nas-${uid}`, "dbus");
}

async function ensureDir(dirPath: string, mode = 0o700): Promise<void> {
  await Deno.mkdir(dirPath, { recursive: true, mode });
  await Deno.chmod(dirPath, mode).catch((error) => {
    if (!(error instanceof Deno.errors.NotSupported)) throw error;
  });
}

async function readPid(pidFile: string): Promise<number | null> {
  try {
    const value = (await Deno.readTextFile(pidFile)).trim();
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    await Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
