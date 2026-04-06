/**
 * Unix listener effect (hostexec-broker).
 */

import type { UnixListenerEffect } from "../types.ts";
import type { ResourceHandle } from "./types.ts";
import { HostExecBroker } from "../../hostexec/broker.ts";
import {
  removeHostExecPendingDir,
  removeHostExecSessionRegistry,
  writeHostExecSessionRegistry,
} from "../../hostexec/registry.ts";
import { logInfo, logWarn } from "../../log.ts";

export async function executeUnixListener(
  effect: UnixListenerEffect,
): Promise<ResourceHandle> {
  const { spec } = effect;

  switch (spec.kind) {
    case "hostexec-broker":
      return await executeHostExecBrokerListener(effect);
    case "session-broker":
      throw new Error("unix-listener session-broker not yet implemented");
  }
}

async function executeHostExecBrokerListener(
  effect: UnixListenerEffect,
): Promise<ResourceHandle> {
  const spec = effect.spec;
  if (spec.kind !== "hostexec-broker") {
    throw new Error(`unexpected listener spec kind: ${spec.kind}`);
  }

  const broker = new HostExecBroker({
    paths: spec.paths,
    sessionId: spec.sessionId,
    profileName: spec.profileName,
    workspaceRoot: spec.workspaceRoot,
    sessionTmpDir: spec.sessionTmpDir,
    hostexec: spec.hostexec,
    notify: spec.notify,
    uiEnabled: spec.uiEnabled,
    uiPort: spec.uiPort,
    uiIdleTimeout: spec.uiIdleTimeout,
    auditDir: spec.auditDir,
  });
  await broker.start(effect.socketPath);

  // Write session registry entry. If this fails, close the broker
  // to avoid leaking a dangling Unix socket listener.
  try {
    await writeHostExecSessionRegistry(spec.paths, {
      version: 1,
      sessionId: spec.sessionId,
      brokerSocket: effect.socketPath,
      profileName: spec.profileName,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      agent: spec.agent,
    });
  } catch (error) {
    try {
      await broker.close();
    } catch (closeErr) {
      logWarn(
        `[nas] HostExec: failed to close broker after registry write failure: ${closeErr}`,
      );
    }
    throw error;
  }

  return {
    kind: "unix-listener",
    close: async () => {
      await broker.close();
      await removeHostExecSessionRegistry(spec.paths, spec.sessionId)
        .catch((e) =>
          logInfo(
            `[nas] HostExec teardown: failed to remove session registry: ${e}`,
          )
        );
      await removeHostExecPendingDir(spec.paths, spec.sessionId).catch(
        (e) =>
          logInfo(
            `[nas] HostExec teardown: failed to remove pending dir: ${e}`,
          ),
      );
    },
  };
}
