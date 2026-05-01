/**
 * Best-effort `turn_events` append from `nas hook`.
 *
 * Hook code must never fail the agent: every error path here (db open,
 * schema mismatch, write) is warned to stderr and swallowed. The function
 * returns void unconditionally.
 *
 * The `conversations` row is upserted with `agent = null` because the hook
 * does not know the agent type. The OTLP receiver fills in `agent` later via
 * COALESCE when spans for the same conversation are ingested.
 */

import type { Database } from "bun:sqlite";
import {
  HistoryDbVersionMismatchError,
  insertTurnEvent,
  openHistoryDb,
  resolveHistoryDbPath,
  upsertConversation,
  upsertConversationSummary,
} from "./store.ts";

export interface AppendTurnEventArgs {
  /** Required. Comes from process.env.NAS_SESSION_ID. */
  invocationId: string;
  /**
   * Optional. session_id (Claude) / sessionId (Copilot) from hook payload.
   * NULL when the payload contains neither.
   */
  conversationId: string | null;
  /** ISO 8601 string with millisecond precision (Z-terminated). */
  ts: string;
  /** "start" | "attention" | "stop" — already parsed by parseHookKind. */
  kind: string;
  /** Raw hook payload. JSON.stringify'd into turn_events.payload_json. */
  payload: unknown;
}

/**
 * Append a turn_event row, idempotently upserting the matching conversation
 * row when a conversation id is known. Best-effort: any DB failure is
 * warned to stderr and swallowed.
 */
export function appendTurnEvent(args: AppendTurnEventArgs): void {
  const dbPath = resolveHistoryDbPath();

  let db: Database;
  try {
    db = openHistoryDb({ path: dbPath, mode: "readwrite" });
  } catch (e) {
    if (e instanceof HistoryDbVersionMismatchError) {
      console.error(
        `nas hook: history db schema version mismatch (expected 1, got ${e.actual}). ` +
          `Run 'rm ${dbPath}' and re-run nas. Skipping turn_event.`,
      );
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `nas hook: history db open failed: ${msg}. Skipping turn_event.`,
      );
    }
    return;
  }

  if (args.conversationId !== null) {
    try {
      upsertConversation(db, {
        id: args.conversationId,
        agent: null,
        firstSeenAt: args.ts,
        lastSeenAt: args.ts,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `nas hook: history conversation upsert failed: ${msg}. Continuing.`,
      );
      // best-effort: when the upsert fails and conversationId is non-null,
      // the insertTurnEvent below likely also FK-fails and warns. Both
      // warnings surface, both are swallowed; that is the hook's
      // "never fails" contract.
    }
  }

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(args.payload ?? {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `nas hook: payload serialize failed: ${msg}. Storing empty payload.`,
    );
    payloadJson = "{}";
  }

  try {
    insertTurnEvent(db, {
      invocationId: args.invocationId,
      conversationId: args.conversationId,
      ts: args.ts,
      kind: args.kind,
      payloadJson,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `nas hook: history turn_event insert failed: ${msg}. Skipping.`,
    );
  }
}

export interface AppendConversationSummaryArgs {
  /** Agent-issued conversation id (the FK target in conversation_summaries). */
  conversationId: string;
  /**
   * The pre-extracted, pre-truncated first user prompt for the conversation.
   *
   * Agent-controlled: callers (the `nas hook` cli) lift this either from
   * the agent's transcript JSONL (Claude `transcript_path`) or directly
   * from the hook payload (Copilot `payload.prompt`). The agent can put any
   * string here. See `extractTranscriptSummary` (transcript_reader.ts) for
   * the matching note on why this is treated as agent-trusted rather than
   * sandboxed.
   */
  summary: string;
  /** ISO 8601 string with millisecond precision (Z-terminated). */
  capturedAt: string;
}

/**
 * Best-effort capture of a conversation's first user prompt as a summary.
 *
 * Writes `summary` to `conversation_summaries` for `conversationId`. Any
 * failure (DB open, schema mismatch, write) is warned to stderr and
 * swallowed — the hook never fails the agent.
 *
 * The conversation_summaries writer uses INSERT OR IGNORE, so a second
 * call against an already-populated row is a no-op. This makes it safe to
 * invoke this from every hook fire, not just the first one.
 */
export function appendConversationSummary(
  args: AppendConversationSummaryArgs,
): void {
  const dbPath = resolveHistoryDbPath();
  let db: Database;
  try {
    db = openHistoryDb({ path: dbPath, mode: "readwrite" });
  } catch (e) {
    if (e instanceof HistoryDbVersionMismatchError) {
      console.error(
        `nas hook: history db schema version mismatch (expected 1, got ${e.actual}). ` +
          `Run 'rm ${dbPath}' and re-run nas. Skipping conversation summary.`,
      );
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `nas hook: history db open failed: ${msg}. Skipping conversation summary.`,
      );
    }
    return;
  }

  try {
    upsertConversationSummary(db, {
      id: args.conversationId,
      summary: args.summary,
      capturedAt: args.capturedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `nas hook: conversation summary upsert failed: ${msg}. Continuing.`,
    );
  }
}
