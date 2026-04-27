/**
 * Pure helpers backing the Sidecars settings page.
 *
 * The module owns three responsibilities:
 *
 *   1. The canonical list of sidecar `nas.kind` labels (`SIDECAR_KINDS`).
 *      Owning the constant here keeps the Solid frontend self-contained
 *      and lets the predicate `isSidecarContainer` ship without any
 *      cross-package import.
 *   2. Predicate + normalizer that turn a raw `ContainerInfoLike[]`
 *      snapshot into the row shape consumed by the table. The normalizer
 *      filters out non-sidecar entries (so the same SSE snapshot can be
 *      fanned out to both the sessions store and the sidecars store) and
 *      sorts deterministically by `kind` then `name`, which matters for
 *      both the rendered order and the tests that pin it.
 *   3. `formatUptime`, a short relative-duration formatter. It takes the
 *      reference epoch as an explicit argument so tests can pin output
 *      without monkey-patching `Date.now`.
 */

import type { ContainerInfoLike } from "../../stores/types";

export const SIDECAR_KINDS = ["dind", "proxy", "envoy"] as const;

export type SidecarKind = (typeof SIDECAR_KINDS)[number];

/**
 * One row in the Sidecars settings table. The shape is intentionally
 * narrower than `ContainerInfoLike` so the page component never reads
 * fields that the daemon does not promise for sidecar containers.
 */
export type SidecarRow = {
  /** Docker container name; doubles as the stable React-style key. */
  name: string;
  /** Sidecar variant; one of `SIDECAR_KINDS`. */
  kind: SidecarKind;
  /** True when the daemon last reported the container as running. */
  running: boolean;
  /** ISO-8601 start timestamp, or `null` when the daemon omitted it. */
  startedAt: string | null;
};

const SIDECAR_KIND_SET: ReadonlySet<string> = new Set<string>(SIDECAR_KINDS);

/**
 * Return true when `c.labels["nas.kind"]` is one of the sidecar kinds.
 *
 * The label, not the container name, is the wire-level discriminant: a
 * user could rename their proxy and the label would still be `"proxy"`.
 */
export function isSidecarContainer(c: ContainerInfoLike): boolean {
  const kind = c.labels["nas.kind"];
  return typeof kind === "string" && SIDECAR_KIND_SET.has(kind);
}

/**
 * Filter and project a raw container snapshot into table rows.
 *
 * Sort order:
 *   - primary: `kind` ascending (`dind` < `envoy` < `proxy`, lexicographic)
 *   - secondary: `name` ascending within the same `kind`
 *
 * The order is deterministic and pinned in tests. When two rows share
 * the same `name` (and thus collide on the table key) the one that
 * appears later in the input wins, matching the natural "last write
 * wins" semantics of a snapshot replacement.
 */
export function normalizeSidecars(items: ContainerInfoLike[]): SidecarRow[] {
  const rows: SidecarRow[] = [];
  // De-duplicate by name; later entries overwrite earlier ones.
  const byName = new Map<string, SidecarRow>();
  for (const c of items) {
    if (!isSidecarContainer(c)) continue;
    // The predicate proved the label is a `SidecarKind`, but TypeScript
    // does not narrow `Record<string,string>` access; cast through the
    // already-validated label.
    const kind = c.labels["nas.kind"] as SidecarKind;
    byName.set(c.name, {
      name: c.name,
      kind,
      running: c.running,
      startedAt: c.startedAt ?? null,
    });
  }
  for (const row of byName.values()) rows.push(row);
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
  return rows;
}

/**
 * Format an ISO-8601 timestamp as a short relative duration from `nowMs`.
 *
 * Returns `"-"` for `null`, for future timestamps (negative delta), and
 * for unparseable input.
 *
 * Output ranges:
 *   - `< 60s`   -> `"5s"`
 *   - `< 60m`   -> `"3m"`
 *   - `< 24h`   -> `"2h"`
 *   - else      -> `"1d"`
 */
export function formatUptime(startedAt: string | null, nowMs: number): string {
  if (startedAt === null) return "-";
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return "-";
  const deltaMs = nowMs - startedMs;
  if (deltaMs < 0) return "-";
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
