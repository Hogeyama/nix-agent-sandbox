/**
 * Generic runtime registry for managing session, pending entry,
 * and broker socket state on the filesystem.
 * Used by both network/registry.ts and hostexec/registry.ts.
 */

import { readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  atomicWriteJson,
  ensureDir,
  isPidAlive,
  pathExists,
  readJsonDir,
  readJsonFile,
  safeRemove,
} from "./fs_utils.ts";

// --- Base types ---

export interface BaseRuntimePaths {
  runtimeDir: string;
  sessionsDir: string;
  pendingDir: string;
  brokersDir: string;
}

export interface BaseSessionEntry {
  sessionId: string;
  pid: number;
  brokerSocket: string;
}

export interface BasePendingEntry {
  sessionId: string;
  requestId: string;
  createdAt: string;
}

// --- Path helpers ---

/**
 * Defense-in-depth: ensure a joined path stays inside `base`. Throws if
 * `joined` escapes (traversal via `..`, absolute path, or equals the base
 * itself). Complements the API-boundary allowlist — even if a future caller
 * forgets to validate its id, this refuses to read/write outside the
 * runtime directory.
 */
function assertWithin(base: string, joined: string): string {
  const rel = path.relative(base, joined);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path traversal detected: ${joined}`);
  }
  return joined;
}

export function sessionRegistryPath(
  paths: BaseRuntimePaths,
  sessionId: string,
): string {
  return assertWithin(
    paths.sessionsDir,
    path.join(paths.sessionsDir, `${sessionId}.json`),
  );
}

export function brokerSocketPath(
  paths: BaseRuntimePaths,
  sessionId: string,
): string {
  return assertWithin(
    paths.brokersDir,
    path.join(paths.brokersDir, `${sessionId}.sock`),
  );
}

export function pendingSessionDir(
  paths: BaseRuntimePaths,
  sessionId: string,
): string {
  return assertWithin(paths.pendingDir, path.join(paths.pendingDir, sessionId));
}

export function pendingRequestPath(
  paths: BaseRuntimePaths,
  sessionId: string,
  requestId: string,
): string {
  const sessionDir = pendingSessionDir(paths, sessionId);
  return assertWithin(sessionDir, path.join(sessionDir, `${requestId}.json`));
}

// --- Session registry CRUD ---

export async function writeSessionRegistry<S extends BaseSessionEntry>(
  paths: BaseRuntimePaths,
  entry: S,
): Promise<void> {
  await atomicWriteJson(sessionRegistryPath(paths, entry.sessionId), entry);
}

export async function readSessionRegistry<S>(
  paths: BaseRuntimePaths,
  sessionId: string,
): Promise<S | null> {
  return await readJsonFile<S>(sessionRegistryPath(paths, sessionId));
}

export async function listSessionRegistries<S>(
  paths: BaseRuntimePaths,
): Promise<S[]> {
  return await readJsonDir<S>(paths.sessionsDir);
}

export async function removeSessionRegistry(
  paths: BaseRuntimePaths,
  sessionId: string,
): Promise<void> {
  await safeRemove(sessionRegistryPath(paths, sessionId));
}

// --- Pending entry CRUD ---

export async function writePendingEntry<P extends BasePendingEntry>(
  paths: BaseRuntimePaths,
  entry: P,
): Promise<void> {
  await ensureDir(pendingSessionDir(paths, entry.sessionId));
  await atomicWriteJson(
    pendingRequestPath(paths, entry.sessionId, entry.requestId),
    entry,
  );
}

export async function removePendingEntry(
  paths: BaseRuntimePaths,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await safeRemove(pendingRequestPath(paths, sessionId, requestId));
}

export async function removePendingDir(
  paths: BaseRuntimePaths,
  sessionId: string,
): Promise<void> {
  await safeRemove(pendingSessionDir(paths, sessionId), { recursive: true });
}

export async function listPendingEntries<P extends BasePendingEntry>(
  paths: BaseRuntimePaths,
  sessionId?: string,
): Promise<P[]> {
  if (sessionId) {
    return await readJsonDir<P>(pendingSessionDir(paths, sessionId));
  }
  const entries: P[] = [];
  try {
    for (const dirEntry of await readdir(paths.pendingDir, {
      withFileTypes: true,
    })) {
      if (!dirEntry.isDirectory()) continue;
      entries.push(
        ...(await readJsonDir<P>(path.join(paths.pendingDir, dirEntry.name))),
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// --- Garbage collection ---

export interface GcResult {
  removedSessions: string[];
  removedPendingDirs: string[];
  removedBrokerSockets: string[];
}

export async function gcRuntime<S extends BaseSessionEntry>(
  paths: BaseRuntimePaths,
): Promise<GcResult> {
  const removedSessions: string[] = [];
  const removedPendingDirs: string[] = [];
  const removedBrokerSockets: string[] = [];

  const sessions = await listSessionRegistries<S>(paths);
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
    (await listSessionRegistries<S>(paths)).map((e) => e.sessionId),
  );

  try {
    for (const dirEntry of await readdir(paths.pendingDir, {
      withFileTypes: true,
    })) {
      if (!dirEntry.isDirectory()) continue;
      if (liveSessionIds.has(dirEntry.name)) continue;
      await removePendingDir(paths, dirEntry.name);
      removedPendingDirs.push(dirEntry.name);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  try {
    for (const socketEntry of await readdir(paths.brokersDir, {
      withFileTypes: true,
    })) {
      if (!socketEntry.isFile() && !socketEntry.isSymbolicLink()) continue;
      const socketPath = path.join(paths.brokersDir, socketEntry.name);
      const sessionId = socketEntry.name.replace(/\.sock$/, "");
      if (liveSessionIds.has(sessionId)) continue;
      await safeRemove(socketPath);
      removedBrokerSockets.push(socketPath);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  return { removedSessions, removedPendingDirs, removedBrokerSockets };
}
