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
import { isNasManagedSidecar } from "../docker/nas_resources.ts";
import { cleanNasContainers } from "../container_clean.ts";
import type { ContainerCleanResult } from "../container_clean.ts";

export interface UiDataContext {
  networkPaths: NetworkRuntimePaths;
  hostExecPaths: HostExecRuntimePaths;
}

export async function createDataContext(
  runtimeDir?: string,
): Promise<UiDataContext> {
  const [networkPaths, hostExecPaths] = await Promise.all([
    resolveNetworkRuntimePaths(runtimeDir),
    resolveHostExecRuntimePaths(runtimeDir),
  ]);
  return { networkPaths, hostExecPaths };
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
    if (isNasManagedSidecar(details.labels, details.name)) {
      containers.push({
        name: details.name,
        running: details.running,
        labels: details.labels,
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
