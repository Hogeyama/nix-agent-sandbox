import * as path from "node:path";
import type { PendingEntry, SessionRegistryEntry } from "./protocol.ts";
import {
  defaultRuntimeDir,
  ensureDir,
  isPidAlive,
  readPid,
  removeIfExists,
} from "../lib/fs_utils.ts";
import {
  type BaseRuntimePaths,
  type GcResult,
  gcRuntime,
  listPendingEntries as genericListPendingEntries,
  listSessionRegistries as genericListSessionRegistries,
  readSessionRegistry as genericReadSessionRegistry,
} from "../lib/runtime_registry.ts";

// Re-export generic functions that don't need return-type narrowing.
export {
  brokerSocketPath,
  pendingRequestPath,
  pendingSessionDir,
  removePendingDir,
  removePendingEntry,
  removeSessionRegistry,
  sessionRegistryPath,
  writePendingEntry,
  writeSessionRegistry,
} from "../lib/runtime_registry.ts";

export interface NetworkRuntimePaths extends BaseRuntimePaths {
  authRouterSocket: string;
  authRouterPidFile: string;
  envoyConfigFile: string;
}

export interface NetworkGcResult extends GcResult {
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

// Typed wrappers for generic read functions.

export async function readSessionRegistry(
  paths: BaseRuntimePaths,
  sessionId: string,
): Promise<SessionRegistryEntry | null> {
  return await genericReadSessionRegistry<SessionRegistryEntry>(
    paths,
    sessionId,
  );
}

export async function listSessionRegistries(
  paths: BaseRuntimePaths,
): Promise<SessionRegistryEntry[]> {
  return await genericListSessionRegistries<SessionRegistryEntry>(paths);
}

export async function listPendingEntries(
  paths: BaseRuntimePaths,
  sessionId?: string,
): Promise<PendingEntry[]> {
  return await genericListPendingEntries<PendingEntry>(paths, sessionId);
}

export async function gcNetworkRuntime(
  paths: NetworkRuntimePaths,
): Promise<NetworkGcResult> {
  const base = await gcRuntime<SessionRegistryEntry>(paths);

  // Network-specific: clean up auth router if its process is dead.
  let removedAuthRouterSocket = false;
  let removedAuthRouterPidFile = false;
  const authRouterPid = await readPid(paths.authRouterPidFile);
  const authRouterAlive =
    authRouterPid !== null && (await isPidAlive(authRouterPid));
  if (!authRouterAlive) {
    removedAuthRouterSocket = await removeIfExists(paths.authRouterSocket);
    removedAuthRouterPidFile = await removeIfExists(paths.authRouterPidFile);
  }

  return {
    ...base,
    removedAuthRouterSocket,
    removedAuthRouterPidFile,
  };
}
