import * as path from "@std/path";
import type { PendingEntry, SessionRegistryEntry } from "./protocol.ts";
import {
  atomicWriteJson,
  defaultRuntimeDir,
  ensureDir,
  isPidAlive,
  pathExists,
  readJsonDir,
  readJsonFile,
  readPid,
  removeIfExists,
  safeRemove,
} from "../lib/fs_utils.ts";

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
  const resolved = runtimeDir ?? defaultRuntimeDir("network");
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
