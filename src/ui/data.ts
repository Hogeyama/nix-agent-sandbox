/**
 * データ取得ロジック — 既存レジストリ/ブローカーからの薄いラッパー
 */

import { readdir } from "node:fs/promises";
import { resolveAuditDir } from "../audit/store.ts";
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
import { makeAuditQueryClient } from "../domain/audit.ts";
import { makeHostExecApprovalClient } from "../domain/hostexec.ts";
import { makeNetworkApprovalClient } from "../domain/network.ts";
import { makeSessionUiClient } from "../domain/session.ts";
import { makeTerminalSessionClient } from "../domain/terminal.ts";
import {
  dtachListSessions,
  dtachNewSession,
  getSocketDir,
  shellEscape,
  socketPathFor,
} from "../dtach/client.ts";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";
import {
  gcHostExecRuntime,
  readHostExecSessionRegistry,
  resolveHostExecRuntimePaths,
} from "../hostexec/registry.ts";
import type {
  HostExecPendingEntry,
  HostExecSessionRegistryEntry,
} from "../hostexec/types.ts";
import { safeRemove } from "../lib/fs_utils.ts";
import type {
  ApprovalScope,
  PendingEntry,
  SessionRegistryEntry,
} from "../network/protocol.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import {
  gcNetworkRuntime,
  listSessionRegistries,
  resolveNetworkRuntimePaths,
} from "../network/registry.ts";
import {
  resolveSessionRuntimePaths,
  type SessionEventKind,
  type SessionRecord,
  type SessionRuntimePaths,
  type SessionTurn,
} from "../sessions/store.ts";
import {
  buildShellSessionId,
  type ParsedShellSessionId,
  parseShellSessionId,
} from "./shell_session_id.ts";

export type { ParsedShellSessionId };
export { buildShellSessionId, parseShellSessionId };

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
  terminalRuntimeDir: string;
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
  const terminalRuntimeDir = getSocketDir();
  return {
    networkPaths,
    hostExecPaths,
    sessionPaths,
    auditDir,
    terminalRuntimeDir,
  };
}

// --- Network ---

const networkClient = makeNetworkApprovalClient();

export async function getNetworkPending(
  ctx: UiDataContext,
): Promise<PendingEntry[]> {
  return await networkClient.listPending(ctx.networkPaths);
}

export async function approveNetwork(
  ctx: UiDataContext,
  sessionId: string,
  requestId: string,
  scope?: ApprovalScope,
): Promise<void> {
  await networkClient.approve(ctx.networkPaths, sessionId, requestId, scope);
}

export async function denyNetwork(
  ctx: UiDataContext,
  sessionId: string,
  requestId: string,
  scope?: ApprovalScope,
): Promise<void> {
  await networkClient.deny(ctx.networkPaths, sessionId, requestId, scope);
}

// --- HostExec ---

const hostexecClient = makeHostExecApprovalClient();

export async function getHostExecPending(
  ctx: UiDataContext,
): Promise<HostExecPendingEntry[]> {
  return await hostexecClient.listPending(ctx.hostExecPaths);
}

export async function approveHostExec(
  ctx: UiDataContext,
  sessionId: string,
  requestId: string,
  scope?: HostExecPromptScope,
): Promise<void> {
  await hostexecClient.approve(ctx.hostExecPaths, sessionId, requestId, scope);
}

export async function denyHostExec(
  ctx: UiDataContext,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await hostexecClient.deny(ctx.hostExecPaths, sessionId, requestId);
}

// --- Sessions ---

const sessionUiClient = makeSessionUiClient();
const terminalClient = makeTerminalSessionClient();

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

export async function getTerminalSessions(
  ctx: UiDataContext,
): Promise<TerminalSessionInfo[]> {
  const sessions = await terminalClient.listSessions(ctx.terminalRuntimeDir);
  return sessions.map((session) => ({
    name: session.name,
    sessionId: session.name,
    socketPath: session.socketPath,
    createdAt: session.createdAt,
  }));
}

/** dtach セッションにアタッチしている他クライアントを全て切断する */
export async function killTerminalClients(
  ctx: UiDataContext,
  sessionId: string,
): Promise<number> {
  return await terminalClient.killClients(ctx.terminalRuntimeDir, sessionId);
}

export async function acknowledgeSessionTurn(
  ctx: UiDataContext,
  sessionId: string,
): Promise<SessionRecord> {
  return await sessionUiClient.acknowledgeTurn(ctx.sessionPaths, sessionId);
}

export async function renameSession(
  ctx: UiDataContext,
  sessionId: string,
  name: string,
): Promise<SessionRecord> {
  return await sessionUiClient.rename(ctx.sessionPaths, sessionId, name);
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

  const sessions = await sessionUiClient.list(ctx.sessionPaths);
  return joinSessionsToContainers(containers, sessions);
}

export async function stopContainer(name: string): Promise<void> {
  let parentSessionId: string | undefined;
  try {
    const details = await dockerInspectContainer(name);
    parentSessionId = details.labels[NAS_SESSION_ID_LABEL];
  } catch {
    // Container may have already been removed; let dockerStop surface the error.
  }
  await dockerStop(name);
  if (parentSessionId) {
    await removeShellSocketsForParent(parentSessionId);
  }
}

export async function cleanContainers(): Promise<ContainerCleanResult> {
  const result = await cleanNasContainers();
  await removeOrphanShellSockets();
  return result;
}

/** Remove shell dtach sockets whose parent agent session matches. */
async function removeShellSocketsForParent(
  parentSessionId: string,
): Promise<void> {
  const sessions = await dtachListSessions();
  for (const session of sessions) {
    const parsed = parseShellSessionId(session.name);
    if (!parsed || parsed.parentSessionId !== parentSessionId) continue;
    await safeRemove(session.socketPath);
  }
}

/** Remove shell sockets whose parent agent session is no longer running. */
async function removeOrphanShellSockets(): Promise<void> {
  const sessions = await dtachListSessions();
  const shellSessions = sessions.flatMap((s) => {
    const parsed = parseShellSessionId(s.name);
    return parsed ? [{ session: s, parsed }] : [];
  });
  if (shellSessions.length === 0) return;

  const runningParents = await collectRunningSessionIds();
  for (const { session, parsed } of shellSessions) {
    if (runningParents.has(parsed.parentSessionId)) continue;
    await safeRemove(session.socketPath);
  }
}

async function collectRunningSessionIds(): Promise<Set<string>> {
  const names = await dockerListContainerNames();
  const running = new Set<string>();
  for (const name of names) {
    try {
      const details = await dockerInspectContainer(name);
      if (!details.running) continue;
      const sid = details.labels[NAS_SESSION_ID_LABEL];
      if (sid) running.add(sid);
    } catch {
      // ignore containers that disappeared between list and inspect
    }
  }
  return running;
}

async function nextShellSessionId(parentSessionId: string): Promise<string> {
  const existing = await dtachListSessions();
  let maxSeq = 0;
  for (const s of existing) {
    const parsed = parseShellSessionId(s.name);
    if (!parsed) continue;
    if (parsed.parentSessionId !== parentSessionId) continue;
    if (parsed.seq > maxSeq) maxSeq = parsed.seq;
  }
  return buildShellSessionId(parentSessionId, maxSeq + 1);
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

  const parentSessionId = details.labels[NAS_SESSION_ID_LABEL];
  if (!parentSessionId) {
    throw new Error(
      `Container ${containerName} has no ${NAS_SESSION_ID_LABEL} label`,
    );
  }

  // 2. dtach セッションID生成
  // 形式: shell-<parentSessionId>.<seq> (seq は 1 始まり)
  // 既存の shell セッションを走査して衝突しない番号を選ぶ。
  const dtachSessionId = await nextShellSessionId(parentSessionId);

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

  // 6. dtach セッション起動 — 失敗時は socket 残骸を掃除する
  try {
    await dtachNewSession(socketPath, shellCommand);
  } catch (error) {
    await safeRemove(socketPath);
    throw error;
  }

  return { dtachSessionId };
}

// --- Audit ---

const auditClient = makeAuditQueryClient();

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
  const entries = await auditClient.query(ctx.auditDir, merged);
  if (limit !== undefined && limit > 0) {
    return entries.slice(-limit);
  }
  return entries;
}
