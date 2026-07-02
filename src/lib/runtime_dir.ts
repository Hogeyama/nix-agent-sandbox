import type { HostEnv } from "../pipeline/types.ts";

/**
 * Resolve a per-subsystem runtime directory using HostEnv.
 *
 * Prefers $XDG_RUNTIME_DIR/nas/<subsystem>; falls back to
 * /tmp/nas-<uid>/<subsystem>.  This is the HostEnv-aware counterpart of
 * `defaultRuntimeDir` in fs_utils.ts (which reads process.env directly).
 */
export function resolveRuntimeSubdir(host: HostEnv, subsystem: string): string {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim().length > 0) {
    return `${xdg}/nas/${subsystem}`;
  }
  const uid = host.uid ?? "unknown";
  return `/tmp/nas-${uid}/${subsystem}`;
}
