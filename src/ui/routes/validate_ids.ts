/**
 * Identifier validation for sessionId / requestId / container name values
 * that arrive from untrusted UI callers.
 *
 * These values flow into `path.join()` calls for session-registry, pending
 * broker, and dtach socket paths. Without validation, a caller that passes
 * the Host/Origin guard (e.g. a local process with curl-set headers) can
 * encode `..` segments to redirect reads/writes outside the runtime dir.
 *
 * The allowlist intentionally matches both the legitimate shapes used today
 * (`sess_<hex>`, `shell-<parent>.<seq>`, ISO-timestamp style ids, docker
 * container names) and plausible future shapes, while rejecting anything
 * containing `/`, `\0`, or a `..` traversal substring.
 */

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" && SAFE_ID_RE.test(value) && !value.includes("..")
  );
}
