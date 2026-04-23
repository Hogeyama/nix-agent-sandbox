/**
 * Filesystem paths for the nas UI daemon.
 *
 * Centralised here so daemon state / token / log files share a single
 * source-of-truth for their directory layout, and so callers outside
 * daemon.ts (e.g. the server bootstrap) can reference them without
 * pulling in daemon-process logic.
 */

import * as path from "node:path";

/** Root directory for persisted UI daemon state (XDG_CACHE_HOME/nas/ui). */
export function daemonStateDir(): string {
  const xdgCache =
    process.env.XDG_CACHE_HOME ||
    path.join(process.env.HOME ?? "/tmp", ".cache");
  return path.join(xdgCache, "nas", "ui");
}

/** Path of the JSON file holding pid/port/startedAt for the running daemon. */
export function daemonStatePath(): string {
  return path.join(daemonStateDir(), "daemon.json");
}

/** Path of the daemon stdout/stderr log. */
export function daemonLogPath(): string {
  return path.join(daemonStateDir(), "daemon.log");
}

/** Path of the WebSocket bearer token file (0600, base64url contents). */
export function daemonTokenPath(): string {
  return path.join(daemonStateDir(), "daemon.token");
}
