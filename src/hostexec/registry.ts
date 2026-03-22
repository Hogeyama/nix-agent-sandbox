import * as path from "@std/path";
import type {
  HostExecPendingEntry,
  HostExecSessionRegistryEntry,
} from "./types.ts";

export interface HostExecRuntimePaths {
  runtimeDir: string;
  sessionsDir: string;
  pendingDir: string;
  brokersDir: string;
  wrappersDir: string;
}

export async function resolveHostExecRuntimePaths(
  runtimeDir?: string,
): Promise<HostExecRuntimePaths> {
  const resolved = runtimeDir ?? defaultRuntimeDir();
  const paths: HostExecRuntimePaths = {
    runtimeDir: resolved,
    sessionsDir: path.join(resolved, "sessions"),
    pendingDir: path.join(resolved, "pending"),
    brokersDir: path.join(resolved, "brokers"),
    wrappersDir: path.join(resolved, "wrappers"),
  };
  await ensureDir(paths.runtimeDir, 0o755);
  await ensureDir(paths.sessionsDir);
  await ensureDir(paths.pendingDir);
  await ensureDir(paths.brokersDir);
  await ensureDir(paths.wrappersDir);
  return paths;
}

export function hostExecBrokerSocketPath(
  paths: HostExecRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.brokersDir, `${sessionId}.sock`);
}

export function hostExecSessionRegistryPath(
  paths: HostExecRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.sessionsDir, `${sessionId}.json`);
}

export function hostExecPendingSessionDir(
  paths: HostExecRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.pendingDir, sessionId);
}

export function hostExecPendingRequestPath(
  paths: HostExecRuntimePaths,
  sessionId: string,
  requestId: string,
): string {
  return path.join(
    hostExecPendingSessionDir(paths, sessionId),
    `${requestId}.json`,
  );
}

export async function writeHostExecSessionRegistry(
  paths: HostExecRuntimePaths,
  entry: HostExecSessionRegistryEntry,
): Promise<void> {
  await atomicWriteJson(
    hostExecSessionRegistryPath(paths, entry.sessionId),
    entry,
  );
}

export async function readHostExecSessionRegistry(
  paths: HostExecRuntimePaths,
  sessionId: string,
): Promise<HostExecSessionRegistryEntry | null> {
  return await readJsonFile<HostExecSessionRegistryEntry>(
    hostExecSessionRegistryPath(paths, sessionId),
  );
}

export async function listHostExecPendingEntries(
  paths: HostExecRuntimePaths,
  sessionId?: string,
): Promise<HostExecPendingEntry[]> {
  if (sessionId) {
    return await readJsonDir<HostExecPendingEntry>(
      hostExecPendingSessionDir(paths, sessionId),
    );
  }
  const items: HostExecPendingEntry[] = [];
  for await (const entry of Deno.readDir(paths.pendingDir)) {
    if (!entry.isDirectory) continue;
    items.push(
      ...await readJsonDir<HostExecPendingEntry>(
        path.join(paths.pendingDir, entry.name),
      ),
    );
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function writeHostExecPendingEntry(
  paths: HostExecRuntimePaths,
  entry: HostExecPendingEntry,
): Promise<void> {
  await ensureDir(hostExecPendingSessionDir(paths, entry.sessionId));
  await atomicWriteJson(
    hostExecPendingRequestPath(paths, entry.sessionId, entry.requestId),
    entry,
  );
}

export async function removeHostExecPendingEntry(
  paths: HostExecRuntimePaths,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await safeRemove(hostExecPendingRequestPath(paths, sessionId, requestId));
}

export async function removeHostExecPendingDir(
  paths: HostExecRuntimePaths,
  sessionId: string,
): Promise<void> {
  await safeRemove(hostExecPendingSessionDir(paths, sessionId), {
    recursive: true,
  });
}

export async function removeHostExecSessionRegistry(
  paths: HostExecRuntimePaths,
  sessionId: string,
): Promise<void> {
  await safeRemove(hostExecSessionRegistryPath(paths, sessionId));
}

export interface HostExecGcResult {
  removedSessions: string[];
  removedPendingDirs: string[];
  removedBrokerSockets: string[];
}

export async function gcHostExecRuntime(
  paths: HostExecRuntimePaths,
): Promise<HostExecGcResult> {
  const removedSessions: string[] = [];
  const removedPendingDirs: string[] = [];
  const removedBrokerSockets: string[] = [];

  // List all session registries
  const sessions = await listHostExecSessionRegistries(paths);
  for (const entry of sessions) {
    const alive = await isPidAlive(entry.pid);
    const brokerExists = await pathExists(entry.brokerSocket);
    if (alive && brokerExists) continue;
    removedSessions.push(entry.sessionId);
    await removeHostExecSessionRegistry(paths, entry.sessionId);
    await removeHostExecPendingDir(paths, entry.sessionId);
    removedPendingDirs.push(entry.sessionId);
    await safeRemove(entry.brokerSocket);
    removedBrokerSockets.push(entry.brokerSocket);
  }

  // Remove orphaned pending dirs (no matching session)
  const liveSessionIds = new Set(
    (await listHostExecSessionRegistries(paths)).map((e) => e.sessionId),
  );
  try {
    for await (const dirEntry of Deno.readDir(paths.pendingDir)) {
      if (!dirEntry.isDirectory) continue;
      if (liveSessionIds.has(dirEntry.name)) continue;
      await removeHostExecPendingDir(paths, dirEntry.name);
      removedPendingDirs.push(dirEntry.name);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  // Remove orphaned broker sockets
  try {
    for await (const socketEntry of Deno.readDir(paths.brokersDir)) {
      if (!socketEntry.isFile && !socketEntry.isSymlink) continue;
      const socketPath = path.join(paths.brokersDir, socketEntry.name);
      const sessionId = socketEntry.name.replace(/\.sock$/, "");
      if (liveSessionIds.has(sessionId)) continue;
      await safeRemove(socketPath);
      removedBrokerSockets.push(socketPath);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  return { removedSessions, removedPendingDirs, removedBrokerSockets };
}

async function listHostExecSessionRegistries(
  paths: HostExecRuntimePaths,
): Promise<HostExecSessionRegistryEntry[]> {
  return await readJsonDir<HostExecSessionRegistryEntry>(paths.sessionsDir);
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    const output = await new Deno.Command("kill", {
      args: ["-0", String(pid)],
      stdout: "null",
      stderr: "null",
    }).output();
    return output.success;
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await Deno.lstat(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function defaultRuntimeDir(): string {
  const xdg = Deno.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim() !== "") {
    return path.join(xdg, "nas", "hostexec");
  }
  const uid = typeof Deno.uid === "function" ? Deno.uid() : "unknown";
  return path.join("/tmp", `nas-${uid}`, "hostexec");
}

async function ensureDir(dirPath: string, mode = 0o700): Promise<void> {
  await Deno.mkdir(dirPath, { recursive: true, mode });
  await chmodIfSupported(dirPath, mode);
}

async function chmodIfSupported(path: string, mode: number): Promise<void> {
  await Deno.chmod(path, mode).catch((error) => {
    if (!(error instanceof Deno.errors.NotSupported)) throw error;
  });
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  await Deno.writeTextFile(tempPath, JSON.stringify(value, null, 2) + "\n", {
    create: true,
    mode: 0o600,
  });
  await Deno.rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(filePath)) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function readJsonDir<T>(dirPath: string): Promise<T[]> {
  try {
    const entries: T[] = [];
    for await (const entry of Deno.readDir(dirPath)) {
      if (!entry.isFile) continue;
      const value = await readJsonFile<T>(path.join(dirPath, entry.name));
      if (value) entries.push(value);
    }
    return entries;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function safeRemove(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  try {
    await Deno.remove(path, options);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
