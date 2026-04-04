/**
 * D-Bus proxy effect.
 */

import type { DbusProxyEffect } from "../types.ts";
import type { ResourceHandle } from "./types.ts";
import { startDbusProxy } from "../../dbus/proxy.ts";

export async function executeDbusProxy(
  effect: DbusProxyEffect,
): Promise<ResourceHandle> {
  const handle = await startDbusProxy({
    proxyBinaryPath: effect.proxyBinaryPath,
    runtimeDir: effect.runtimeDir,
    sessionsDir: effect.sessionsDir,
    sessionDir: effect.sessionDir,
    socketPath: effect.socketPath,
    pidFile: effect.pidFile,
    args: effect.args,
    timeoutMs: effect.timeoutMs,
    pollIntervalMs: effect.pollIntervalMs,
  });

  return {
    kind: "dbus-proxy",
    close: () => handle.close(),
  };
}
