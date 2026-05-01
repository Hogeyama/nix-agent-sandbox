/**
 * Wire-name constants for the history SSE streams.
 *
 * Pulled out of `history_sse.ts` so frontend bundles can import the
 * vocabulary without dragging the server module's runtime dependencies
 * (Router, UiDataContext, …) through the type resolver.
 */
export const HISTORY_SSE_EVENT_NAMES = [
  "history:list",
  "history:conversation",
  "history:invocation",
  "history:not-found",
] as const;

export type HistorySseEventName = (typeof HISTORY_SSE_EVENT_NAMES)[number];

/**
 * Named per-event constants. Consumers reference these instead of
 * indexing `HISTORY_SSE_EVENT_NAMES` so a tuple reorder cannot silently
 * point a listener at a different event. The `satisfies` clause keeps
 * the string literal in lockstep with `HistorySseEventName`.
 */
export const HISTORY_SSE_LIST_EVENT =
  "history:list" as const satisfies HistorySseEventName;
export const HISTORY_SSE_CONVERSATION_EVENT =
  "history:conversation" as const satisfies HistorySseEventName;
export const HISTORY_SSE_INVOCATION_EVENT =
  "history:invocation" as const satisfies HistorySseEventName;
export const HISTORY_SSE_NOT_FOUND_EVENT =
  "history:not-found" as const satisfies HistorySseEventName;
