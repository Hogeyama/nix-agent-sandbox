import * as path from "node:path";
import { defaultRuntimeDir, ensureDir } from "../lib/fs_utils.ts";
import {
  type BaseRuntimePaths,
  type GcResult,
  gcRuntime,
  listPendingEntries as genericListPendingEntries,
  readSessionRegistry as genericReadSessionRegistry,
} from "../lib/runtime_registry.ts";
import type {
  HostExecPendingEntry,
  HostExecSessionRegistryEntry,
} from "./types.ts";

// Re-export generic functions with domain-specific names.
export {
  brokerSocketPath as hostExecBrokerSocketPath,
  pendingRequestPath as hostExecPendingRequestPath,
  pendingSessionDir as hostExecPendingSessionDir,
  removePendingDir as removeHostExecPendingDir,
  removePendingEntry as removeHostExecPendingEntry,
  removeSessionRegistry as removeHostExecSessionRegistry,
  sessionBrokerDir as hostExecSessionBrokerDir,
  sessionRegistryPath as hostExecSessionRegistryPath,
  writePendingEntry as writeHostExecPendingEntry,
  writeSessionRegistry as writeHostExecSessionRegistry,
} from "../lib/runtime_registry.ts";

export interface HostExecRuntimePaths extends BaseRuntimePaths {
  wrappersDir: string;
}

export type HostExecGcResult = GcResult;

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

// Typed wrappers for generic read functions.

export async function readHostExecSessionRegistry(
  paths: BaseRuntimePaths,
  sessionId: string,
): Promise<HostExecSessionRegistryEntry | null> {
  return await genericReadSessionRegistry<HostExecSessionRegistryEntry>(
    paths,
    sessionId,
  );
}

export async function listHostExecPendingEntries(
  paths: BaseRuntimePaths,
  sessionId?: string,
): Promise<HostExecPendingEntry[]> {
  return await genericListPendingEntries<HostExecPendingEntry>(
    paths,
    sessionId,
  );
}

export async function gcHostExecRuntime(
  paths: HostExecRuntimePaths,
): Promise<HostExecGcResult> {
  return await gcRuntime<HostExecSessionRegistryEntry>(paths);
}
