/**
 * UI-side reader for the history database.
 *
 * Opens the history db in read-only mode and exposes the three query
 * functions consumed by the UI daemon. All entry points are best-effort:
 * if the db file is absent (= nas has never run), or open fails for any
 * reason (schema mismatch, permission issue), list queries return an
 * empty array and detail queries return null. The intent is that an
 * observability-disabled environment still surfaces the same API shape
 * to its consumer.
 */

import { existsSync } from "node:fs";
import {
  type ConversationDetail,
  type ConversationListRow,
  HistoryDbVersionMismatchError,
  type InvocationDetail,
  type ModelTokenTotalsRow,
  openHistoryDb,
  queryConversationDetail,
  queryConversationList,
  queryConversationModelTokenTotals,
  queryInvocationDetail,
  queryModelTokenTotals,
  resolveHistoryDbPath,
} from "../history/store.ts";

export interface ReadHistoryOptions {
  /** Optional override of the resolved history db path (for tests). */
  readonly dbPath?: string;
}

function resolvePath(opts?: ReadHistoryOptions): string {
  return opts?.dbPath ?? resolveHistoryDbPath();
}

function openReader(dbPath: string): ReturnType<typeof openHistoryDb> | null {
  if (!existsSync(dbPath)) return null;
  try {
    return openHistoryDb({ path: dbPath, mode: "readonly" });
  } catch (e) {
    if (e instanceof HistoryDbVersionMismatchError) {
      console.warn(`[nas:history] ${e.message}`);
      return null;
    }
    console.warn(
      `[nas:history] failed to open history db at ${dbPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * List conversations newest-first. Returns [] when the db is unavailable
 * or the underlying query fails (e.g. SQL error against a corrupted but
 * version-matching db).
 */
export function readConversationList(
  opts?: ReadHistoryOptions,
): ConversationListRow[] {
  const dbPath = resolvePath(opts);
  const db = openReader(dbPath);
  if (!db) return [];
  try {
    return queryConversationList(db);
  } catch (e) {
    console.warn(
      `[nas:history] queryConversationList failed at ${dbPath}: ${describeError(e)}`,
    );
    return [];
  }
}

/**
 * Returns null when the db is unavailable, the conversation is missing,
 * or the underlying query fails.
 */
export function readConversationDetail(
  id: string,
  opts?: ReadHistoryOptions,
): ConversationDetail | null {
  const dbPath = resolvePath(opts);
  const db = openReader(dbPath);
  if (!db) return null;
  try {
    return queryConversationDetail(db, id);
  } catch (e) {
    console.warn(
      `[nas:history] queryConversationDetail failed at ${dbPath} (id=${id}): ${describeError(e)}`,
    );
    return null;
  }
}

/**
 * Returns null when the db is unavailable, the invocation is missing,
 * or the underlying query fails.
 */
export function readInvocationDetail(
  id: string,
  opts?: ReadHistoryOptions,
): InvocationDetail | null {
  const dbPath = resolvePath(opts);
  const db = openReader(dbPath);
  if (!db) return null;
  try {
    return queryInvocationDetail(db, id);
  } catch (e) {
    console.warn(
      `[nas:history] queryInvocationDetail failed at ${dbPath} (id=${id}): ${describeError(e)}`,
    );
    return null;
  }
}

/**
 * Per-model token totals for spans started at or after `sinceIso`. Returns
 * [] when the db is unavailable or the underlying query fails. The caller
 * (commit 5: SSE delivery) chooses the window — this layer is policy-free.
 */
export function readModelTokenTotals(
  sinceIso: string,
  opts?: ReadHistoryOptions,
): ModelTokenTotalsRow[] {
  const dbPath = resolvePath(opts);
  const db = openReader(dbPath);
  if (!db) return [];
  try {
    return queryModelTokenTotals(db, { sinceIso });
  } catch (e) {
    console.warn(
      `[nas:history] queryModelTokenTotals failed at ${dbPath} (sinceIso=${sinceIso}): ${describeError(e)}`,
    );
    return [];
  }
}

/**
 * Per-model token totals scoped to one conversation (joined through
 * `traces.conversation_id`). Returns [] when the db is unavailable or the
 * underlying query fails.
 */
export function readConversationModelTokenTotals(
  conversationId: string,
  opts?: ReadHistoryOptions,
): ModelTokenTotalsRow[] {
  const dbPath = resolvePath(opts);
  const db = openReader(dbPath);
  if (!db) return [];
  try {
    return queryConversationModelTokenTotals(db, conversationId);
  } catch (e) {
    console.warn(
      `[nas:history] queryConversationModelTokenTotals failed at ${dbPath} (id=${conversationId}): ${describeError(e)}`,
    );
    return [];
  }
}
