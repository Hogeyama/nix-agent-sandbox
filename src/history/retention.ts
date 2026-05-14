import type { Database } from "bun:sqlite";

/**
 * Result of a single prune pass: the number of rows deleted from the
 * top-level `invocations` and `conversations` tables. Cascaded child
 * deletes (log_records / spans / traces) are intentionally not counted
 * separately — the caller is interested in coarse retention progress.
 */
export interface PruneResult {
  invocationsDeleted: number;
  conversationsDeleted: number;
}

export interface ThrottledPruneResult extends PruneResult {
  /** True when the call returned without touching the database. */
  skipped: boolean;
}

interface ChangesRow {
  changes: number;
}

/**
 * Default throttle window for {@link pruneHistoryWithThrottle}. One hour:
 * retention is a low-frequency maintenance task and we do not want every
 * writer-open to walk the tables.
 */
export const DEFAULT_PRUNE_THROTTLE_MS = 3_600_000;

/**
 * Delete history rows whose owning invocation started before
 * `now - retentionSeconds`. Runs in a single transaction so the cascade
 * is all-or-nothing.
 *
 * Strictly-less-than semantics: rows with `started_at` exactly at the
 * cutoff are kept. The cutoff itself is derived from `now` and the
 * caller-supplied retention window; `now` is injected to keep the
 * function deterministic and testable.
 *
 * Defensive no-op when `retentionSeconds <= 0`: returns `{0, 0}` without
 * touching the database. The pipeline-level config validation rejects
 * non-positive retention values before this function is called, so this
 * branch only fires when a caller bypasses that check.
 *
 * Throws on SQL errors (e.g. missing schema). Callers that need
 * best-effort behaviour should catch at the call site.
 */
export function pruneHistory(
  db: Database,
  retentionSeconds: number,
  now: Date,
): PruneResult {
  if (retentionSeconds <= 0) {
    return { invocationsDeleted: 0, conversationsDeleted: 0 };
  }

  const cutoffIso = new Date(
    now.getTime() - retentionSeconds * 1000,
  ).toISOString();

  // `changes()` reflects the most recent DELETE on the same connection,
  // so we capture it immediately after the relevant statement runs and
  // before the next DELETE rewrites it.
  const result: PruneResult = {
    invocationsDeleted: 0,
    conversationsDeleted: 0,
  };

  const tx = db.transaction((cutoff: string) => {
    // Child rows first so foreign_keys=ON enforcement does not fire on the
    // parent delete. log_records and spans reach `invocations` through
    // different join paths, so each gets its own scoped subquery.
    db.prepare(
      `DELETE FROM log_records
       WHERE invocation_id IN (
         SELECT id FROM invocations WHERE started_at < ?
       )`,
    ).run(cutoff);

    db.prepare(
      `DELETE FROM spans
       WHERE trace_id IN (
         SELECT trace_id FROM traces
         WHERE invocation_id IN (
           SELECT id FROM invocations WHERE started_at < ?
         )
       )`,
    ).run(cutoff);

    db.prepare(
      `DELETE FROM traces
       WHERE invocation_id IN (
         SELECT id FROM invocations WHERE started_at < ?
       )`,
    ).run(cutoff);

    db.prepare(`DELETE FROM invocations WHERE started_at < ?`).run(cutoff);
    const invChanges = db
      .query("SELECT changes() AS changes")
      .get() as ChangesRow;
    result.invocationsDeleted = invChanges.changes;

    // Conversations are orphaned once their last_seen_at is past the
    // cutoff AND no surviving trace references them. We check `traces`
    // after the trace-delete above, so this only deletes truly orphaned
    // rows; conversations with newer traces are preserved.
    db.prepare(
      `DELETE FROM conversations
       WHERE last_seen_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM traces t WHERE t.conversation_id = conversations.id
         )`,
    ).run(cutoff);
    const convChanges = db
      .query("SELECT changes() AS changes")
      .get() as ChangesRow;
    result.conversationsDeleted = convChanges.changes;
  });
  tx(cutoffIso);

  return result;
}

/**
 * Per-process, per-`dbPath` throttle state. A single nas process may hold
 * the writer handle for the lifetime of a long-running daemon, so we
 * remember when prune last ran to avoid re-scanning on every open.
 */
const lastPrunedAt = new Map<string, number>();

/**
 * Throttled wrapper around {@link pruneHistory}.
 *
 * Skips the prune when the previous successful run for the same `dbPath`
 * was less than `minIntervalMs` ago. On success, records `now.getTime()`
 * as the new baseline; on throw, the map is left untouched so the next
 * call retries.
 *
 * When `retentionSeconds <= 0`, the inner function returns `{0, 0}`
 * without touching the database; the throttle map is also left untouched
 * because there is nothing to amortise.
 */
export function pruneHistoryWithThrottle(
  db: Database,
  dbPath: string,
  retentionSeconds: number,
  now: Date,
  minIntervalMs: number = DEFAULT_PRUNE_THROTTLE_MS,
): ThrottledPruneResult {
  if (retentionSeconds <= 0) {
    return {
      invocationsDeleted: 0,
      conversationsDeleted: 0,
      skipped: false,
    };
  }

  const nowMs = now.getTime();
  const last = lastPrunedAt.get(dbPath);
  if (last !== undefined && nowMs - last < minIntervalMs) {
    return {
      invocationsDeleted: 0,
      conversationsDeleted: 0,
      skipped: true,
    };
  }

  const result = pruneHistory(db, retentionSeconds, now);
  lastPrunedAt.set(dbPath, nowMs);
  return { ...result, skipped: false };
}

/** Test-only helper: clear the throttle map. */
export function _resetPruneThrottle(): void {
  lastPrunedAt.clear();
}
