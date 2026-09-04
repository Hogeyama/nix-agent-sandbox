import * as path from "node:path";
import { defaultRuntimeDir, ensureDir } from "../lib/fs_utils.ts";
import {
  type BaseRuntimePaths,
  type GcResult,
  gcRuntime,
  listPendingEntries as genericListPendingEntries,
  listSessionRegistries as genericListSessionRegistries,
  readSessionRegistry as genericReadSessionRegistry,
} from "../lib/runtime_registry.ts";
import type { PendingEntry, SessionRegistryEntry } from "./protocol.ts";

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
  caCertDir: string;
  addonScriptPath: string;
  /** セッションごとの解決済み認可ドキュメントを置くディレクトリ。 */
  authzDir: string;
}

/**
 * The proxy CA's certificate, without its private key.
 *
 * mitmproxy's cert store keeps the key in sibling files (`mitmproxy-ca.pem`,
 * `mitmproxy-ca.p12`), so callers that hand this path to a container must pass
 * the file and never its directory.
 */
export function caCertFilePath(paths: { readonly caCertDir: string }): string {
  return path.join(paths.caCertDir, "mitmproxy-ca-cert.pem");
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
    caCertDir: path.join(resolved, "mitmproxy-ca"),
    addonScriptPath: path.join(resolved, "nas_addon.py"),
    authzDir: path.join(resolved, "authz"),
  };
  await ensureDir(paths.runtimeDir, 0o755);
  await ensureDir(paths.sessionsDir);
  await ensureDir(paths.pendingDir);
  await ensureDir(paths.brokersDir);
  await ensureDir(paths.caCertDir);
  await ensureDir(paths.authzDir);
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
): Promise<GcResult> {
  return await gcRuntime<SessionRegistryEntry>(paths);
}
