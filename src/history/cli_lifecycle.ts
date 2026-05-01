/**
 * CLI-side lifecycle wrapper around the history `invocations` table.
 *
 * Telemetry must never block an agent run, so every public entry point in
 * this module is best-effort: failures are logged to stderr and swallowed.
 * The CLI continues regardless.
 */

import type { Database } from "bun:sqlite";
import type { AgentType } from "../config/types.ts";
import {
  HistoryDbVersionMismatchError,
  markInvocationEnded,
  openHistoryDb,
  resolveHistoryDbPath,
  upsertInvocation,
} from "./store.ts";

export interface InvocationLifecycleArgs {
  sessionId: string;
  profileName: string;
  agent: AgentType;
  worktreePath?: string;
}

export type InvocationExitReason = "ok" | "error";

/**
 * Decide whether the current process should write the invocation row.
 *
 * The dtach parent (the process that spawned the master via `dtach -n` and
 * is about to exit) must skip writing — only the child running inside the
 * dtach session (`NAS_INSIDE_DTACH=1`) writes. This keeps the row
 * lifecycle aligned with the actual agent process, not the launcher.
 *
 * Defense-in-depth: in the production path `runInsideDtach` already
 * early-returns the parent before this function is called, so the parent
 * branch here is a second line of defense in case that contract changes.
 */
export function shouldRecordInvocation(
  profile: { session?: { multiplex?: boolean } },
  env: Record<string, string | undefined>,
): boolean {
  if (profile.session?.multiplex && env.NAS_INSIDE_DTACH !== "1") return false;
  return true;
}

/**
 * Open the history db and upsert the invocation row.
 *
 * Returns the db handle on success, or `null` if anything failed (db open,
 * schema mismatch, write). On failure a single stderr warning is emitted;
 * callers should pass the result through to {@link recordInvocationEnd}
 * which is null-safe.
 */
export function recordInvocationStart(
  args: InvocationLifecycleArgs,
): Database | null {
  let db: Database;
  try {
    db = openHistoryDb({
      path: resolveHistoryDbPath(),
      mode: "readwrite",
    });
  } catch (e) {
    if (e instanceof HistoryDbVersionMismatchError) {
      console.error(
        `nas: history db schema version mismatch (expected 1, got ${e.actual}). ` +
          `Run 'rm ${resolveHistoryDbPath()}' and re-run nas to recreate. ` +
          `Continuing without history.`,
      );
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `nas: history db open failed: ${msg}. Continuing without history.`,
      );
    }
    return null;
  }

  try {
    upsertInvocation(db, {
      id: args.sessionId,
      profile: args.profileName,
      agent: args.agent,
      worktreePath: args.worktreePath ?? null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitReason: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `nas: history invocation upsert failed: ${msg}. Continuing without history.`,
    );
    return null;
  }

  return db;
}

/**
 * Mark the invocation as ended. No-op when `db` is null (i.e. start failed
 * and we already warned). Errors here are warned and swallowed too.
 */
export function recordInvocationEnd(
  db: Database | null,
  args: { sessionId: string; exitReason: InvocationExitReason },
): void {
  if (db === null) return;
  try {
    markInvocationEnded(db, {
      id: args.sessionId,
      endedAt: new Date().toISOString(),
      exitReason: args.exitReason,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`nas: history invocation end failed: ${msg}.`);
  }
}
