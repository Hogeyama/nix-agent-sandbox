import * as path from "@std/path";
import type { PendingEntry, SessionRegistryEntry } from "./protocol.ts";

export interface NetworkRuntimePaths {
  runtimeDir: string;
  sessionsDir: string;
  pendingDir: string;
  brokersDir: string;
  authRouterSocket: string;
  authRouterPidFile: string;
  envoyConfigFile: string;
}

export interface NetworkGcResult {
  removedSessions: string[];
  removedPendingDirs: string[];
  removedBrokerSockets: string[];
  removedAuthRouterSocket: boolean;
  removedAuthRouterPidFile: boolean;
}

export async function resolveNetworkRuntimePaths(
  runtimeDir?: string,
): Promise<NetworkRuntimePaths> {
  const resolved = runtimeDir ?? defaultRuntimeDir();
  const paths: NetworkRuntimePaths = {
    runtimeDir: resolved,
    sessionsDir: path.join(resolved, "sessions"),
    pendingDir: path.join(resolved, "pending"),
    brokersDir: path.join(resolved, "brokers"),
    authRouterSocket: path.join(resolved, "auth-router.sock"),
    authRouterPidFile: path.join(resolved, "auth-router.pid"),
    envoyConfigFile: path.join(resolved, "envoy.yaml"),
  };
  await ensureDir(paths.runtimeDir, 0o755);
  await ensureDir(paths.sessionsDir);
  await ensureDir(paths.pendingDir);
  await ensureDir(paths.brokersDir);
  return paths;
}

export function sessionRegistryPath(
  paths: NetworkRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.sessionsDir, `${sessionId}.json`);
}

export function brokerSocketPath(
  paths: NetworkRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.brokersDir, `${sessionId}.sock`);
}

export function pendingSessionDir(
  paths: NetworkRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.pendingDir, sessionId);
}

export function pendingRequestPath(
  paths: NetworkRuntimePaths,
  sessionId: string,
  requestId: string,
): string {
  return path.join(pendingSessionDir(paths, sessionId), `${requestId}.json`);
}

export async function writeSessionRegistry(
  paths: NetworkRuntimePaths,
  entry: SessionRegistryEntry,
): Promise<void> {
  await atomicWriteJson(sessionRegistryPath(paths, entry.sessionId), entry);
}

export async function readSessionRegistry(
  paths: NetworkRuntimePaths,
  sessionId: string,
): Promise<SessionRegistryEntry | null> {
  return await readJsonFile<SessionRegistryEntry>(
    sessionRegistryPath(paths, sessionId),
  );
}

export async function listSessionRegistries(
  paths: NetworkRuntimePaths,
): Promise<SessionRegistryEntry[]> {
  return await readJsonDir<SessionRegistryEntry>(paths.sessionsDir);
}

export async function removeSessionRegistry(
  paths: NetworkRuntimePaths,
  sessionId: string,
): Promise<void> {
  await safeRemove(sessionRegistryPath(paths, sessionId));
}

export async function writePendingEntry(
  paths: NetworkRuntimePaths,
  entry: PendingEntry,
): Promise<void> {
  await ensureDir(pendingSessionDir(paths, entry.sessionId));
  await atomicWriteJson(
    pendingRequestPath(paths, entry.sessionId, entry.requestId),
    entry,
  );
}

export async function removePendingEntry(
  paths: NetworkRuntimePaths,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await safeRemove(pendingRequestPath(paths, sessionId, requestId));
}

export async function removePendingDir(
  paths: NetworkRuntimePaths,
  sessionId: string,
): Promise<void> {
  await safeRemove(pendingSessionDir(paths, sessionId), { recursive: true });
}

export async function listPendingEntries(
  paths: NetworkRuntimePaths,
  sessionId?: string,
): Promise<PendingEntry[]> {
  if (sessionId) {
    return await readJsonDir<PendingEntry>(pendingSessionDir(paths, sessionId));
  }

  const entries: PendingEntry[] = [];
  for await (const dirEntry of Deno.readDir(paths.pendingDir)) {
    if (!dirEntry.isDirectory) continue;
    entries.push(
      ...await readJsonDir<PendingEntry>(
        path.join(paths.pendingDir, dirEntry.name),
      ),
    );
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function gcNetworkRuntime(
  paths: NetworkRuntimePaths,
): Promise<NetworkGcResult> {
  const removedSessions: string[] = [];
  const removedPendingDirs: string[] = [];
  const removedBrokerSockets: string[] = [];

  const sessions = await listSessionRegistries(paths);
  for (const entry of sessions) {
    const alive = await isPidAlive(entry.pid);
    const brokerExists = await pathExists(entry.brokerSocket);
    if (alive && brokerExists) continue;
    removedSessions.push(entry.sessionId);
    await removeSessionRegistry(paths, entry.sessionId);
    await removePendingDir(paths, entry.sessionId);
    removedPendingDirs.push(entry.sessionId);
    await safeRemove(entry.brokerSocket);
    removedBrokerSockets.push(entry.brokerSocket);
  }

  const liveSessionIds = new Set(
    (await listSessionRegistries(paths)).map((entry) => entry.sessionId),
  );

  for await (const dirEntry of Deno.readDir(paths.pendingDir)) {
    if (!dirEntry.isDirectory) continue;
    if (liveSessionIds.has(dirEntry.name)) continue;
    await removePendingDir(paths, dirEntry.name);
    removedPendingDirs.push(dirEntry.name);
  }

  for await (const socketEntry of Deno.readDir(paths.brokersDir)) {
    if (!socketEntry.isFile && !socketEntry.isSymlink) continue;
    const socketPath = path.join(paths.brokersDir, socketEntry.name);
    const sessionId = socketEntry.name.replace(/\.sock$/, "");
    if (liveSessionIds.has(sessionId)) continue;
    await safeRemove(socketPath);
    removedBrokerSockets.push(socketPath);
  }

  let removedAuthRouterSocket = false;
  let removedAuthRouterPidFile = false;
  const authRouterPid = await readPid(paths.authRouterPidFile);
  const authRouterAlive = authRouterPid !== null &&
    await isPidAlive(authRouterPid);
  if (!authRouterAlive) {
    removedAuthRouterSocket = await removeIfExists(paths.authRouterSocket);
    removedAuthRouterPidFile = await removeIfExists(paths.authRouterPidFile);
  }

  return {
    removedSessions,
    removedPendingDirs,
    removedBrokerSockets,
    removedAuthRouterSocket,
    removedAuthRouterPidFile,
  };
}

function defaultRuntimeDir(): string {
  const xdg = Deno.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg, "nas", "network");
  }
  const uid = typeof Deno.uid === "function" ? Deno.uid() : "unknown";
  return path.join("/tmp", `nas-${uid}`, "network");
}

async function ensureDir(dirPath: string, mode = 0o700): Promise<void> {
  await Deno.mkdir(dirPath, { recursive: true, mode });
  await chmodIfSupported(dirPath, mode);
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
    const items: T[] = [];
    for await (const entry of Deno.readDir(dirPath)) {
      if (!entry.isFile) continue;
      const item = await readJsonFile<T>(path.join(dirPath, entry.name));
      if (item) items.push(item);
    }
    return items;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function safeRemove(
  targetPath: string,
  options?: Deno.RemoveOptions,
): Promise<void> {
  try {
    await Deno.remove(targetPath, options);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function removeIfExists(targetPath: string): Promise<boolean> {
  if (!await pathExists(targetPath)) return false;
  await safeRemove(targetPath);
  return true;
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

async function readPid(pidFile: string): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(pidFile);
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
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

async function chmodIfSupported(
  targetPath: string,
  mode: number,
): Promise<void> {
  try {
    await Deno.chmod(targetPath, mode);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotSupported)) {
      throw error;
    }
  }
}
