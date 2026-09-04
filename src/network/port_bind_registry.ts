import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { defaultRuntimeDir, ensureDir, safeRemove } from "../lib/fs_utils.ts";
import {
  assertWithin,
  type BaseRuntimePaths,
  type GcResult,
  gcRuntime,
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
  /**
   * Root of the per-session directories holding the relay script that
   * containers mount read-only.
   */
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

/**
 * Each session gets its own copy of the relay script.
 *
 * The script is bind-mounted into the container as a single file, and Docker
 * pins such a mount to the inode it resolved at create time. `copyRelayScript`
 * publishes the script with a rename, which installs a *new* inode — so a
 * shared path would leave every already-running container mounting a deleted
 * inode as soon as the next session started, and its relay could never be
 * exec'd again. Keeping one copy per session means no session ever replaces a
 * file another session's container is mounting.
 */
export function sessionRelayDir(
  paths: PortsRuntimePaths,
  sessionId: string,
): string {
  return assertWithin(paths.relayDir, path.join(paths.relayDir, sessionId));
}

export function relayScriptPath(
  paths: PortsRuntimePaths,
  sessionId: string,
): string {
  const dir = sessionRelayDir(paths, sessionId);
  return assertWithin(dir, path.join(dir, "port-relay.mjs"));
}

/**
 * `gcRuntime` sweeps the directories every subsystem shares; the relay
 * directories exist only here, so they need their own pass. A session that
 * died without running its release never removed its script copy, and nothing
 * else would ever reclaim it.
 */
export async function gcPortsRuntime(
  paths: PortsRuntimePaths,
): Promise<GcResult> {
  const result = await gcRuntime<PortBindSessionEntry>(paths);
  const liveSessionIds = new Set(
    (await listPortBindSessions(paths)).map((entry) => entry.sessionId),
  );
  try {
    for (const dirEntry of await readdir(paths.relayDir, {
      withFileTypes: true,
    })) {
      if (!dirEntry.isDirectory()) continue;
      if (liveSessionIds.has(dirEntry.name)) continue;
      await safeRemove(sessionRelayDir(paths, dirEntry.name), {
        recursive: true,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
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
