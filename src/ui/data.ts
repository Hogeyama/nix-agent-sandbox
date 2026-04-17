/**
 * データ取得ロジック — 既存レジストリ/ブローカーからの薄いラッパー
 */

import { readdir } from "node:fs/promises";
import { queryAuditLogs, resolveAuditDir } from "../audit/store.ts";
import type { AuditLogEntry, AuditLogFilter } from "../audit/types.ts";
import type { HostExecPromptScope } from "../config/types.ts";
import type { ContainerCleanResult } from "../container_clean.ts";
import { cleanNasContainers } from "../container_clean.ts";
import type { DockerContainerDetails } from "../docker/client.ts";
import {
  dockerInspectContainer,
  dockerListContainerNames,
  dockerStop,
} from "../docker/client.ts";
import {
  isNasManagedContainer,
  NAS_SESSION_ID_LABEL,
} from "../docker/nas_resources.ts";
import {
  dtachListSessions,
  dtachNewSession,
  shellEscape,
  socketPathFor,
} from "../dtach/client.ts";
import { sendHostExecBrokerRequest } from "../hostexec/broker.ts";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";
import {
  gcHostExecRuntime,
  listHostExecPendingEntries,
  readHostExecSessionRegistry,
  resolveHostExecRuntimePaths,
} from "../hostexec/registry.ts";
import type {
  HostExecPendingEntry,
  HostExecSessionRegistryEntry,
} from "../hostexec/types.ts";
import { sendBrokerRequest } from "../network/broker.ts";
import type {
  ApprovalScope,
  PendingEntry,
  SessionRegistryEntry,
} from "../network/protocol.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import {
  gcNetworkRuntime,
  listPendingEntries,
  listSessionRegistries,
  readSessionRegistry,
  resolveNetworkRuntimePaths,
} from "../network/registry.ts";
import {
  listSessions,
  acknowledgeSessionTurn as markSessionTurnAcknowledged,
  resolveSessionRuntimePaths,
  type SessionEventKind,
  type SessionRecord,
  type SessionRuntimePaths,
  type SessionTurn,
  updateSessionName as storeUpdateSessionName,
} from "../sessions/store.ts";
/** Thrown when a shell session is requested for a container that is not running. */
export class ContainerNotRunningError extends Error {
  constructor(containerName: string) {
    super(`Container is not running: ${containerName}`);
    this.name = "ContainerNotRunningError";
  }
}

/** Thrown when an operation targets a container not managed by nas. */
export class NotNasManagedContainerError extends Error {
  constructor(containerName: string) {
    super(`Not a nas-managed container: ${containerName}`);
    this.name = "NotNasManagedContainerError";
  }
}

export interface UiDataContext {
  networkPaths: NetworkRuntimePaths;
  hostExecPaths: HostExecRuntimePaths;
  sessionPaths: SessionRuntimePaths;
  auditDir: string;
}

export async function createDataContext(): Promise<UiDataContext> {
  const [networkPaths, hostExecPaths] = await Promise.all([
    resolveNetworkRuntimePaths(),
    resolveHostExecRuntimePaths(),
  ]);
  const sessionPaths = resolveSessionRuntimePaths();
  // 起動時に stale な session/pending を掃除
  const [netGc, hexGc] = await Promise.all([
    gcNetworkRuntime(networkPaths),
    gcHostExecRuntime(hostExecPaths),
  ]);
  const netRemoved =
    netGc.removedSessions.length +
    netGc.removedPendingDirs.length +
    netGc.removedBrokerSockets.length;
  const hexRemoved =
    hexGc.removedSessions.length +
    hexGc.removedPendingDirs.length +
    hexGc.removedBrokerSockets.length;
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

export interface TerminalSessionInfo {
  name: string;
  sessionId: string;
  socketPath: string;
  createdAt: number;
}

export async function getSessions(ctx: UiDataContext): Promise<SessionsData> {
  await gcNetworkRuntime(ctx.networkPaths);
  const networkSessions = await listSessionRegistries(ctx.networkPaths);

  // hostexec has no listSessionRegistries, read from sessionsDir
  const hostexecSessions: HostExecSessionRegistryEntry[] = [];
  try {
    for (const entry of await readdir(ctx.hostExecPaths.sessionsDir, {
      withFileTypes: true,
    })) {
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

export async function getTerminalSessions(): Promise<TerminalSessionInfo[]> {
  const sessions = await dtachListSessions();
  return sessions.map((session) => ({
    name: session.name,
    sessionId: session.name,
    socketPath: session.socketPath,
    createdAt: session.createdAt,
  }));
}

export async function acknowledgeSessionTurn(
  ctx: UiDataContext,
  sessionId: string,
): Promise<SessionRecord> {
  return await markSessionTurnAcknowledged(ctx.sessionPaths, sessionId);
}

export async function renameSession(
  ctx: UiDataContext,
  sessionId: string,
  name: string,
): Promise<SessionRecord> {
  return await storeUpdateSessionName(ctx.sessionPaths, sessionId, name);
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
  sessionName?: string;
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
      sessionName: record.name,
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

export async function startShellSession(
  containerName: string,
): Promise<{ dtachSessionId: string }> {
  // 1. nas 管理コンテナかどうかを検証し、稼働確認
  const details = await dockerInspectContainer(containerName);
  if (!isNasManagedContainer(details.labels, details.name)) {
    throw new NotNasManagedContainerError(containerName);
  }
  if (!details.running) {
    throw new ContainerNotRunningError(containerName);
  }

  // 2. dtach セッションID生成
  const randomBytes = crypto.getRandomValues(new Uint8Array(6));
  const dtachSessionId = `shell-${Buffer.from(randomBytes).toString("hex")}`;

  // 3. ソケットパス取得
  const socketPath = socketPathFor(dtachSessionId);

  // 4. コマンド文字列構築
  // entrypoint.sh --shell を root で起動し、その中で setpriv により
  // agent と同じ NAS_UID/NAS_GID・PATH・Nix 環境の bash にドロップする。
  // docker exec はデフォルトで ENTRYPOINT を通らないため明示的に呼ぶ。
  const execArgs = [
    "docker",
    "exec",
    "-it",
    "-u",
    "0:0",
    containerName,
    "/entrypoint.sh",
    "--shell",
  ];
  const shellCommand = shellEscape(execArgs);

  // 6. dtach セッション起動
  await dtachNewSession(socketPath, shellCommand);

  return { dtachSessionId };
}

// --- Audit ---

/** Command prefixes hidden from the UI by default (noisy internal traffic). */
const DEFAULT_EXCLUDE_COMMAND_PREFIXES = ["nas hook"];

export async function getAuditLogs(
  ctx: UiDataContext,
  filter: AuditLogFilter = {},
  limit?: number,
): Promise<AuditLogEntry[]> {
  const merged: AuditLogFilter = {
    excludeCommandPrefixes: DEFAULT_EXCLUDE_COMMAND_PREFIXES,
    ...filter,
  };
  const entries = await queryAuditLogs(merged, ctx.auditDir);
  if (limit !== undefined && limit > 0) {
    return entries.slice(-limit);
  }
  return entries;
}
