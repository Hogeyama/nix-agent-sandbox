/**
 * D-Bus proxy effect.
 */

import { startDbusProxy } from "../../dbus/proxy.ts";
import type { DbusProxyEffect, ResourceHandle } from "./types.ts";

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
