/**
 * Server info — small endpoint exposing host environment that the frontend
 * needs to render paths in a human-friendly way (e.g. shortening cwd to
 * `~/...`).
 *
 * Intentionally separate from {@link ./launch.ts}'s `LaunchInfo`: launch info
 * is scoped to the new-session dialog, while this is a general-purpose host
 * info channel meant to grow over time. Keeping them apart avoids coupling
 * unrelated UI surfaces to the same payload.
 */

export interface Info {
  home: string | null;
}

/**
 * Read host info from the given env (defaults to `process.env`).
 *
 * `HOME` is normalized so that an empty string is treated as unset (returns
 * `null`). Never throws — the UI must degrade gracefully when `HOME` is not
 * available rather than failing to render.
 */
export function getInfo(
  env: { HOME?: string } = { HOME: process.env.HOME },
): Info {
  const home = env.HOME;
  if (typeof home !== "string" || home.length === 0) {
    return { home: null };
  }
  return { home };
}
