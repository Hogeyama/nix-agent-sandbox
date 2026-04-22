/**
 * データ取得ロジック — 既存レジストリ/ブローカーからの薄いラッパー
 */

import { readdir } from "node:fs/promises";
import { resolveAuditDir } from "../audit/store.ts";
import type { AuditLogEntry, AuditLogFilter } from "../audit/types.ts";
import type { HostExecPromptScope } from "../config/types.ts";
import type { ContainerCleanResult } from "../container_clean.ts";
import { cleanNasContainers } from "../container_clean.ts";
import { dockerInspectContainer, dockerStop } from "../docker/client.ts";
import {
  isNasManagedContainer,
  NAS_SESSION_ID_LABEL,
} from "../docker/nas_resources.ts";
import { makeAuditQueryClient } from "../domain/audit.ts";
import {
  joinSessionsToContainers,
  makeContainerQueryClient,
  type NasContainerInfo,
} from "../domain/container.ts";
import { makeHostExecApprovalClient } from "../domain/hostexec.ts";
import { makeSessionLaunchClient } from "../domain/launch.ts";
import { makeNetworkApprovalClient } from "../domain/network.ts";
import { makeSessionUiClient } from "../domain/session.ts";
import { makeTerminalSessionClient } from "../domain/terminal.ts";
import { getSocketDir } from "../dtach/client.ts";
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
  type SessionRecord,
  type SessionRuntimePaths,
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
const launchClient = makeSessionLaunchClient();
const containerQueryClient = makeContainerQueryClient();

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

// `NasContainerInfo` / `joinSessionsToContainers` は `domain/container/`
// に移設済。本 shim は既存 import path を保つための re-export。
export type { NasContainerInfo };
export { joinSessionsToContainers };

export async function getNasContainers(
  ctx: UiDataContext,
): Promise<NasContainerInfo[]> {
  return await containerQueryClient.listManagedWithSessions(ctx.sessionPaths);
}

export async function stopContainer(
  ctx: UiDataContext,
  name: string,
): Promise<void> {
  let parentSessionId: string | undefined;
  try {
    const details = await dockerInspectContainer(name);
    parentSessionId = details.labels[NAS_SESSION_ID_LABEL];
  } catch {
    // Container may have already been removed; let dockerStop surface the error.
  }
  await dockerStop(name);
  if (parentSessionId) {
    await launchClient.removeShellSocketsForParent(
      ctx.terminalRuntimeDir,
      parentSessionId,
    );
  }
}

export async function cleanContainers(
  ctx: UiDataContext,
): Promise<ContainerCleanResult> {
  const result = await cleanNasContainers();
  // `removeOrphanShellSockets` は docker 依存を切り離した契約なので、
  // running parent 集合は ContainerQueryService 経由で取得する
  // (Phase 3 Commit 2 で wrapper の docker 直叩き中間状態を解消済)。
  const runningParents = await containerQueryClient.collectRunningParentIds();
  await launchClient.removeOrphanShellSockets(
    ctx.terminalRuntimeDir,
    runningParents,
  );
  return result;
}

export async function startShellSession(
  ctx: UiDataContext,
  containerName: string,
): Promise<{ dtachSessionId: string }> {
  // docker inspect guard は wrapper 側に残置 (Phase 3 ContainerLifecycleService
  // 前提)。nas 管理コンテナであり running 状態であることを確認した上で、
  // dtach 起動自体は SessionLaunchService に委譲する。
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

  return await launchClient.startShellSession(ctx.terminalRuntimeDir, {
    containerName,
    parentSessionId,
  });
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
