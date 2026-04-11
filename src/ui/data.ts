/**
 * データ取得ロジック — 既存レジストリ/ブローカーからの薄いラッパー
 */

import { readdir } from "node:fs/promises";
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
import {
  isNasManagedContainer,
  NAS_SESSION_ID_LABEL,
} from "../docker/nas_resources.ts";
import { cleanNasContainers } from "../container_clean.ts";
import type { ContainerCleanResult } from "../container_clean.ts";
import { queryAuditLogs, resolveAuditDir } from "../audit/store.ts";
import type { AuditLogEntry } from "../audit/types.ts";
import type { AuditLogFilter } from "../audit/types.ts";
import {
  listSessions,
  resolveSessionRuntimePaths,
} from "../sessions/store.ts";
import type {
  SessionEventKind,
  SessionRecord,
  SessionRuntimePaths,
  SessionTurn,
} from "../sessions/store.ts";

export interface UiDataContext {
  networkPaths: NetworkRuntimePaths;
  hostExecPaths: HostExecRuntimePaths;
  sessionPaths: SessionRuntimePaths;
  auditDir: string;
}

export async function createDataContext(
  runtimeDir?: string,
): Promise<UiDataContext> {
  const [networkPaths, hostExecPaths, sessionPaths] = await Promise.all([
    resolveNetworkRuntimePaths(runtimeDir),
    resolveHostExecRuntimePaths(runtimeDir),
    resolveSessionRuntimePaths(),
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
  return { networkPaths, hostExecPaths, sessionPaths, auditDir };
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
  scope?: ApprovalScope,
): Promise<void> {
  await gcNetworkRuntime(ctx.networkPaths);
  const session = await readSessionRegistry(ctx.networkPaths, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  await sendBrokerRequest(session.brokerSocket, {
    type: "deny",
    requestId,
    scope,
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
    for (
      const entry of await readdir(ctx.hostExecPaths.sessionsDir, {
        withFileTypes: true,
      })
    ) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const sessionId = entry.name.replace(/\.json$/, "");
      const reg = await readHostExecSessionRegistry(
        ctx.hostExecPaths,
        sessionId,
      );
      if (reg) hostexecSessions.push(reg);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  return { network: networkSessions, hostexec: hostexecSessions };
}

// --- Containers ---

export interface NasContainerInfo {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  startedAt: string;
  // Session-derived fields — populated by joinSessionsToContainers when a
  // container carries a `nas.session_id` label matching a live record.
  sessionId?: string;
  turn?: SessionTurn;
  sessionAgent?: string;
  sessionProfile?: string;
  worktree?: string;
  sessionStartedAt?: string;
  lastEventAt?: string;
  lastEventKind?: SessionEventKind;
  lastEventMessage?: string;
}

/**
 * Pure function: overlay session record data onto containers via the
 * `nas.session_id` label. Containers without a label, or with a label
 * that has no matching record, are returned unchanged (shallow-copied).
 */
export function joinSessionsToContainers(
  containers: NasContainerInfo[],
  sessions: SessionRecord[],
): NasContainerInfo[] {
  const bySessionId = new Map<string, SessionRecord>();
  for (const record of sessions) {
    bySessionId.set(record.sessionId, record);
  }

  return containers.map((container) => {
    const sessionId = container.labels[NAS_SESSION_ID_LABEL];
    if (!sessionId) return { ...container };
    const record = bySessionId.get(sessionId);
    if (!record) return { ...container };
    return {
      ...container,
      sessionId: record.sessionId,
      turn: record.turn,
      sessionAgent: record.agent,
      sessionProfile: record.profile,
      worktree: record.worktree,
      sessionStartedAt: record.startedAt,
      lastEventAt: record.lastEventAt,
      lastEventKind: record.lastEventKind,
      lastEventMessage: record.lastEventMessage,
    };
  });
}

export async function getNasContainers(
  ctx: UiDataContext,
): Promise<NasContainerInfo[]> {
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

  const sessions = await listSessions(ctx.sessionPaths);
  return joinSessionsToContainers(containers, sessions);
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
