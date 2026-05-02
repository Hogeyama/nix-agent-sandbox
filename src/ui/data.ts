/**
 * データ取得ロジック — 既存レジストリ/ブローカーからの薄いラッパー
 */

import { readdir } from "node:fs/promises";
import { resolveAuditDir } from "../audit/store.ts";
import type { AuditLogEntry, AuditLogFilter } from "../audit/types.ts";
import type { HostExecPromptScope } from "../config/types.ts";
import type { ContainerCleanResult } from "../container_clean.ts";
import { makeAuditQueryClient } from "../domain/audit.ts";
import {
  makeContainerLifecycleClient,
  makeContainerQueryClient,
  type NasContainerInfo,
} from "../domain/container.ts";
import { makeHostExecApprovalClient } from "../domain/hostexec.ts";
import { makeNetworkApprovalClient } from "../domain/network.ts";
import { makeSessionUiClient } from "../domain/session.ts";
import { makeTerminalSessionClient } from "../domain/terminal.ts";
import { getSocketDir } from "../dtach/client.ts";
import type {
  ConversationDetail,
  ConversationListRow,
  InvocationDetail,
} from "../history/store.ts";
import { resolveHistoryDbPath } from "../history/store.ts";
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
  readConversationDetail,
  readConversationList,
  readInvocationDetail,
} from "./history_data.ts";
import { getPricingSnapshot, type PricingSnapshot } from "./pricing.ts";
import {
  buildShellSessionId,
  type ParsedShellSessionId,
  parseShellSessionId,
} from "./shell_session_id.ts";

export type { ParsedShellSessionId };
export { buildShellSessionId, parseShellSessionId };

export interface UiHistoryReader {
  readConversationList(): ConversationListRow[];
  readConversationDetail(id: string): ConversationDetail | null;
  readInvocationDetail(id: string): InvocationDetail | null;
}

/**
 * Pricing snapshot reader. Implementations must never throw — see
 * `getPricingSnapshot()` for the documented "always return a snapshot"
 * contract. Injected via `UiDataContext.pricing` so tests can substitute
 * deterministic responses without monkey-patching the module.
 */
export interface UiPricingReader {
  getSnapshot(): Promise<PricingSnapshot>;
}

export interface UiDataContext {
  networkPaths: NetworkRuntimePaths;
  hostExecPaths: HostExecRuntimePaths;
  sessionPaths: SessionRuntimePaths;
  auditDir: string;
  terminalRuntimeDir: string;
  historyDbPath: string;
  history: UiHistoryReader;
  pricing: UiPricingReader;
}

function makeHistoryReader(historyDbPath: string): UiHistoryReader {
  return {
    readConversationList: () => readConversationList({ dbPath: historyDbPath }),
    readConversationDetail: (id) =>
      readConversationDetail(id, { dbPath: historyDbPath }),
    readInvocationDetail: (id) =>
      readInvocationDetail(id, { dbPath: historyDbPath }),
  };
}

/**
 * Default pricing reader binding. `getPricingSnapshot()` performs its own
 * module-level cache + in-flight memoisation, so this thunk is a thin
 * forwarder rather than another caching layer.
 */
function makePricingReader(): UiPricingReader {
  return {
    getSnapshot: () => getPricingSnapshot(),
  };
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
  const historyDbPath = resolveHistoryDbPath();
  return {
    networkPaths,
    hostExecPaths,
    sessionPaths,
    auditDir,
    terminalRuntimeDir,
    historyDbPath,
    history: makeHistoryReader(historyDbPath),
    pricing: makePricingReader(),
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
const containerQueryClient = makeContainerQueryClient();
const lifecycleClient = makeContainerLifecycleClient();

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

export type { NasContainerInfo };

export async function getNasContainers(
  ctx: UiDataContext,
): Promise<NasContainerInfo[]> {
  return await containerQueryClient.listManagedWithSessions(ctx.sessionPaths);
}

export async function stopContainer(
  ctx: UiDataContext,
  name: string,
): Promise<void> {
  await lifecycleClient.stopContainer(ctx.terminalRuntimeDir, name);
}

export async function cleanContainers(
  ctx: UiDataContext,
): Promise<ContainerCleanResult> {
  return await lifecycleClient.cleanContainers(ctx.terminalRuntimeDir);
}

export async function startShellSession(
  ctx: UiDataContext,
  containerName: string,
): Promise<{ dtachSessionId: string }> {
  return await lifecycleClient.startShellSession(
    ctx.terminalRuntimeDir,
    containerName,
  );
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
