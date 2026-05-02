/**
 * Filesystem paths for the nas UI daemon.
 *
 * Centralised here so daemon state / token / log files share a single
 * source-of-truth for their directory layout, and so callers outside
 * daemon.ts (e.g. the server bootstrap) can reference them without
 * pulling in daemon-process logic.
 */

import * as path from "node:path";

/** Root directory for persisted UI daemon state (XDG_STATE_HOME/nas/ui). */
export function daemonStateDir(): string {
  const stateRoot =
    process.env.XDG_STATE_HOME ||
    path.join(process.env.HOME ?? "/tmp", ".local", "state");
  return path.join(stateRoot, "nas", "ui");
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

/**
 * Directory holding the LiteLLM pricing snapshot cache
 * (`$XDG_CACHE_HOME/nas/pricing`, falling back to `~/.cache/nas/pricing`).
 *
 * Pricing data is regenerable from a public URL and from the
 * bundled fallback, so it lives under the cache hierarchy rather
 * than the state hierarchy.
 */
export function pricingCacheDir(): string {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ||
    path.join(process.env.HOME ?? "/tmp", ".cache");
  return path.join(cacheRoot, "nas", "pricing");
}

/** Path of the cached LiteLLM pricing snapshot JSON. */
export function pricingCachePath(): string {
  return path.join(pricingCacheDir(), "litellm.json");
}
