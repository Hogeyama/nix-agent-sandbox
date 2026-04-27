/**
 * Pure helper that shortens an absolute filesystem path to a `~`-prefixed
 * form when it sits beneath the current user's home directory.
 *
 * Returns `null` when `path` is `null` so call sites can compose the
 * result with `?? "—"` without a wrapper. The function never throws and
 * never reads global state — it is intentionally a pure transformation
 * so it can be tested in isolation from the `/api/info` round-trip.
 *
 * Boundary handling:
 *
 *   - `home === null || home === ""` → return `path` unchanged. This is
 *     the `home is unknown` degraded path; the UI still renders the
 *     absolute form.
 *   - `path === home` → `"~"`.
 *   - `path` strictly under `home` → `"~" + path.slice(home.length)`.
 *   - Otherwise → `path` unchanged.
 *
 * Trailing-slash normalization: a `home` value like `"/home/foo/"` is
 * treated identically to `"/home/foo"` so users with shells that export
 * `HOME` with a trailing slash still get the shortening. A trailing
 * slash on `path` is preserved in the output (e.g. `"/home/foo/repo/"`
 * with `home="/home/foo"` yields `"~/repo/"`).
 *
 * False-positive guard: when `home === "/home/foo"` and
 * `path === "/home/foobar"`, the function must not produce `"~bar"`.
 * The boundary check inspects the character immediately after `home` in
 * `path` and only shortens when it is `/` (the next path segment).
 */
export function tildifyPath(
  path: string | null,
  home: string | null,
): string | null {
  if (path === null) return null;
  if (home === null || home === "") return path;

  // Strip a trailing slash from `home` and `path` so a shell-exported
  // `HOME=/home/foo/` and a path like `"/home/foo/"` collapse to the
  // same canonical form for the equality check. The slash-prefixed
  // sub-path branch below uses the normalized home for the boundary
  // test as well, so `/home/foo/repo` still produces `~/repo`.
  const normalizedHome = home.endsWith("/") ? home.slice(0, -1) : home;
  // After stripping, an all-slash `home` (e.g. `"/"`) collapses to "".
  // Treat that as `home is unknown` and leave `path` alone rather than
  // tildifying every absolute path on the system.
  if (normalizedHome === "") return path;
  const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;

  if (normalizedPath === normalizedHome) return "~";
  if (path.startsWith(`${normalizedHome}/`)) {
    return `~${path.slice(normalizedHome.length)}`;
  }
  return path;
}
