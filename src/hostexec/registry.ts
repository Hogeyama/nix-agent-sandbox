import * as path from "@std/path";
import type {
  HostExecPendingEntry,
  HostExecSessionRegistryEntry,
} from "./types.ts";
import {
  atomicWriteJson,
  defaultRuntimeDir,
  ensureDir,
  isPidAlive,
  pathExists,
  readJsonDir,
  readJsonFile,
  safeRemove,
} from "../lib/fs_utils.ts";

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
  const resolved = runtimeDir ?? defaultRuntimeDir("hostexec");
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
