/**
 * データ取得ロジック — 既存レジストリ/ブローカーからの薄いラッパー
 */

import {
  gcNetworkRuntime,
  listPendingEntries,
  listSessionRegistries,
  readSessionRegistry,
  resolveNetworkRuntimePaths,
} from "../network/registry.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import type {
  ApprovalScope,
  PendingEntry,
  SessionRegistryEntry,
} from "../network/protocol.ts";
import { sendBrokerRequest } from "../network/broker.ts";
import {
  gcHostExecRuntime,
  listHostExecPendingEntries,
  readHostExecSessionRegistry,
  resolveHostExecRuntimePaths,
} from "../hostexec/registry.ts";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";
import type {
  HostExecPendingEntry,
  HostExecSessionRegistryEntry,
} from "../hostexec/types.ts";
import { sendHostExecBrokerRequest } from "../hostexec/broker.ts";
import type { HostExecPromptScope } from "../config/types.ts";
import {
  dockerInspectContainer,
  dockerListContainerNames,
  dockerStop,
} from "../docker/client.ts";
import type { DockerContainerDetails } from "../docker/client.ts";
import { isNasManagedContainer } from "../docker/nas_resources.ts";
import { cleanNasContainers } from "../container_clean.ts";
import type { ContainerCleanResult } from "../container_clean.ts";
import { queryAuditLogs, resolveAuditDir } from "../audit/store.ts";
import type { AuditLogEntry } from "../audit/types.ts";
import type { AuditLogFilter } from "../audit/types.ts";

export interface UiDataContext {
  networkPaths: NetworkRuntimePaths;
  hostExecPaths: HostExecRuntimePaths;
  auditDir: string;
}

export async function createDataContext(
  runtimeDir?: string,
): Promise<UiDataContext> {
  const [networkPaths, hostExecPaths] = await Promise.all([
    resolveNetworkRuntimePaths(runtimeDir),
    resolveHostExecRuntimePaths(runtimeDir),
  ]);
  // 起動時に stale な session/pending を掃除
  const [netGc, hexGc] = await Promise.all([
    gcNetworkRuntime(networkPaths),
    gcHostExecRuntime(hostExecPaths),
  ]);
  const netRemoved = netGc.removedSessions.length +
    netGc.removedPendingDirs.length + netGc.removedBrokerSockets.length;
  const hexRemoved = hexGc.removedSessions.length +
    hexGc.removedPendingDirs.length + hexGc.removedBrokerSockets.length;
  if (netRemoved > 0 || hexRemoved > 0) {
    console.log(
      `[nas] GC: removed ${netGc.removedSessions.length} network session(s), ${hexGc.removedSessions.length} hostexec session(s)`,
    );
  }
  const auditDir = resolveAuditDir();
  return { networkPaths, hostExecPaths, auditDir };
}

// --- Network ---

export async function getNetworkPending(
  ctx: UiDataContext,
): Promise<PendingEntry[]> {
  await gcNetworkRuntime(ctx.networkPaths);
  return await listPendingEntries(ctx.networkPaths);
}

export async function approveNetwork(
  ctx: UiDataContext,
  sessionId: string,
  requestId: string,
  scope?: ApprovalScope,
): Promise<void> {
  await gcNetworkRuntime(ctx.networkPaths);
  const session = await readSessionRegistry(ctx.networkPaths, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  await sendBrokerRequest(session.brokerSocket, {
    type: "approve",
    requestId,
    scope,
  });
}

export async function denyNetwork(
  ctx: UiDataContext,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await gcNetworkRuntime(ctx.networkPaths);
  const session = await readSessionRegistry(ctx.networkPaths, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  await sendBrokerRequest(session.brokerSocket, {
    type: "deny",
    requestId,
  });
}

// --- HostExec ---

export async function getHostExecPending(
  ctx: UiDataContext,
): Promise<HostExecPendingEntry[]> {
  await gcHostExecRuntime(ctx.hostExecPaths);
  return await listHostExecPendingEntries(ctx.hostExecPaths);
}

export async function approveHostExec(
  ctx: UiDataContext,
  sessionId: string,
  requestId: string,
  scope?: HostExecPromptScope,
): Promise<void> {
  const session = await readHostExecSessionRegistry(
    ctx.hostExecPaths,
    sessionId,
  );
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  await sendHostExecBrokerRequest(session.brokerSocket, {
    type: "approve",
    requestId,
    scope,
  });
}

export async function denyHostExec(
  ctx: UiDataContext,
  sessionId: string,
  requestId: string,
): Promise<void> {
  const session = await readHostExecSessionRegistry(
    ctx.hostExecPaths,
    sessionId,
  );
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  await sendHostExecBrokerRequest(session.brokerSocket, {
    type: "deny",
    requestId,
  });
}

// --- Sessions ---

export interface SessionsData {
  network: SessionRegistryEntry[];
  hostexec: HostExecSessionRegistryEntry[];
}

export async function getSessions(ctx: UiDataContext): Promise<SessionsData> {
  await gcNetworkRuntime(ctx.networkPaths);
  const networkSessions = await listSessionRegistries(ctx.networkPaths);

  // hostexec has no listSessionRegistries, read from sessionsDir
  const hostexecSessions: HostExecSessionRegistryEntry[] = [];
  try {
    for await (const entry of Deno.readDir(ctx.hostExecPaths.sessionsDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const sessionId = entry.name.replace(/\.json$/, "");
      const reg = await readHostExecSessionRegistry(
        ctx.hostExecPaths,
        sessionId,
      );
      if (reg) hostexecSessions.push(reg);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  return { network: networkSessions, hostexec: hostexecSessions };
}

// --- Containers ---

export interface NasContainerInfo {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  startedAt: string;
}

export async function getNasContainers(): Promise<NasContainerInfo[]> {
  const names = await dockerListContainerNames();
  const containers: NasContainerInfo[] = [];

  for (const name of names) {
    let details: DockerContainerDetails;
    try {
      details = await dockerInspectContainer(name);
    } catch {
      continue;
    }
    if (isNasManagedContainer(details.labels, details.name)) {
      containers.push({
        name: details.name,
        running: details.running,
        labels: details.labels,
        startedAt: details.startedAt,
      });
    }
  }

  return containers;
}

export async function stopContainer(name: string): Promise<void> {
  await dockerStop(name);
}

export async function cleanContainers(): Promise<ContainerCleanResult> {
  return await cleanNasContainers();
}

// --- Audit ---

export async function getAuditLogs(
  ctx: UiDataContext,
  filter: AuditLogFilter = {},
  limit?: number,
): Promise<AuditLogEntry[]> {
  const entries = await queryAuditLogs(filter, ctx.auditDir);
  if (limit !== undefined && limit > 0) {
    return entries.slice(-limit);
  }
  return entries;
}
