import * as path from "node:path";
import { defaultRuntimeDir, ensureDir } from "../lib/fs_utils.ts";
import {
  type BaseRuntimePaths,
  listSessionRegistries,
  sessionBrokerDir,
} from "../lib/runtime_registry.ts";
import type { PortBindSessionEntry } from "./port_bind_protocol.ts";

export {
  brokerSocketPath,
  readSessionRegistry,
  removeSessionRegistry,
  writeSessionRegistry,
} from "../lib/runtime_registry.ts";

export interface PortsRuntimePaths extends BaseRuntimePaths {
  /** Directory holding the relay script that containers mount read-only. */
  relayDir: string;
}

/**
 * The session process and the CLI must agree on where the sockets live, and
 * they derive it from different sources — a stage has the probed host env, the
 * CLI has `process.env`. Both go through here so they cannot drift.
 */
export function portsRuntimeDir(
  xdgRuntimeDir: string | undefined,
  uid: number | string,
): string {
  if (xdgRuntimeDir && xdgRuntimeDir.trim().length > 0) {
    return path.join(xdgRuntimeDir, "nas", "ports");
  }
  return path.join("/tmp", `nas-${uid}`, "ports");
}

export async function resolvePortsRuntimePaths(
  runtimeDir?: string,
): Promise<PortsRuntimePaths> {
  const resolved = runtimeDir ?? defaultRuntimeDir("ports");
  const paths: PortsRuntimePaths = {
    runtimeDir: resolved,
    sessionsDir: path.join(resolved, "sessions"),
    pendingDir: path.join(resolved, "pending"),
    brokersDir: path.join(resolved, "brokers"),
    relayDir: path.join(resolved, "relay"),
  };
  await ensureDir(paths.runtimeDir);
  await ensureDir(paths.sessionsDir);
  await ensureDir(paths.brokersDir);
  await ensureDir(paths.relayDir);
  return paths;
}

/**
 * The socket the container connects to. It sits beside the control socket in
 * the session's broker dir, and only this file is bind-mounted, so the control
 * socket stays invisible to the container.
 */
export function relaySocketPath(
  paths: BaseRuntimePaths,
  sessionId: string,
): string {
  return path.join(sessionBrokerDir(paths, sessionId), "relay.sock");
}

export function relayScriptPath(paths: PortsRuntimePaths): string {
  return path.join(paths.relayDir, "port-relay.mjs");
}

export function listPortBindSessions(
  paths: BaseRuntimePaths,
): Promise<PortBindSessionEntry[]> {
  return listSessionRegistries<PortBindSessionEntry>(paths);
}

/**
 * A host port names no session by itself. Every claimant is returned so the
 * caller can refuse an ambiguous match rather than guess.
 */
export async function findSessionsByHostPort(
  paths: BaseRuntimePaths,
  hostPort: number,
): Promise<PortBindSessionEntry[]> {
  const sessions = await listPortBindSessions(paths);
  return sessions.filter((session) =>
    session.bindings.some((binding) => binding.hostPort === hostPort),
  );
}
