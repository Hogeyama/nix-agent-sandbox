/**
 * Agent-specific OTLP span identity rules.
 *
 * Span classification implements the priority order from ADR 2026042901
 * "Span classification". The first layer that matches wins; lower layers are
 * not consulted. Conversation-id resolution scans semantic-convention ids
 * before Codex fallback ids so vendor fallback attributes cannot override a
 * canonical conversation/session id observed anywhere in the trace.
 */

export type SpanKind = "chat" | "execute_tool" | "invoke_agent" | "other";

export interface TraceUsageSources {
  hasCodexTokenUsage: boolean;
  hasCodexResponseOrStreamWithUsage: boolean;
}

export interface ResolveSpanUsageColumnsInput {
  kind: SpanKind;
  spanName: string;
  attrs: Record<string, unknown>;
  traceUsageSources: TraceUsageSources;
}

export interface SpanUsageColumns {
  model: string | null;
  inTok: number | null;
  outTok: number | null;
  cacheR: number | null;
  cacheW: number | null;
}

const CANONICAL_OPS: ReadonlySet<string> = new Set([
  "chat",
  "execute_tool",
  "invoke_agent",
]);

export function classifySpan(
  name: string,
  attrs: Record<string, unknown>,
): SpanKind {
  // Layer 1: explicit gen_ai.operation.name attribute.
  const op = attrs["gen_ai.operation.name"];
  if (typeof op === "string" && CANONICAL_OPS.has(op)) {
    return op as SpanKind;
  }

  // Layer 2: span name is exactly one of the canonical operations, or an
  // OpenLLMetry-style `gen_ai.client.operation[.<suffix>]` chat variant.
  if (name === "chat" || name === "execute_tool" || name === "invoke_agent") {
    return name as SpanKind;
  }
  if (
    name === "gen_ai.client.operation" ||
    name.startsWith("gen_ai.client.operation.")
  ) {
    return "chat";
  }

  // Layer 3: Claude Code vendor span names.
  if (name === "claude_code.llm_request") {
    return "chat";
  }
  if (name === "claude_code.tool" || name.startsWith("claude_code.tool.")) {
    return "execute_tool";
  }

  // Layer 4: Codex CLI span names.
  if (
    name === "session_task.turn" ||
    name === "session_task.review" ||
    name === "session_task.compact"
  ) {
    return "invoke_agent";
  }
  if (name === "session_task.user_shell" || name === "mcp.tools.call") {
    return "execute_tool";
  }
  if (
    name === "codex.turn.token_usage" ||
    name === "codex.response" ||
    name === "codex.responses" ||
    name === "model_client.stream_responses" ||
    name === "model_client.stream_responses_websocket" ||
    name === "responses.stream_request" ||
    name === "responses_websocket.stream_request"
  ) {
    return "chat";
  }

  // Layer 5: Copilot CLI `<op> <subject>` whitespace-prefixed names.
  if (name.startsWith("chat ")) return "chat";
  if (name.startsWith("execute_tool ")) return "execute_tool";
  if (name.startsWith("invoke_agent ")) return "invoke_agent";

  // Layer 6: presence of gen_ai.system marks the span as a chat regardless
  // of an unrecognised name (catches vendor-specific naming we don't model).
  if (typeof attrs["gen_ai.system"] === "string") {
    return "chat";
  }

  // Layer 7: fallback.
  return "other";
}

export interface ResolveConversationInput {
  spans: ReadonlyArray<{ attributes?: Record<string, unknown> }>;
}

export function pickConversationIdFromSpans(
  spans: ResolveConversationInput["spans"],
): string | null {
  for (const span of spans) {
    const attrs = span.attributes ?? {};
    const genAi = attrs["gen_ai.conversation.id"];
    if (typeof genAi === "string" && genAi.length > 0) {
      return genAi;
    }
    const sess = attrs["session.id"];
    if (typeof sess === "string" && sess.length > 0) {
      return sess;
    }
  }
  for (const span of spans) {
    const attrs = span.attributes ?? {};
    const codexConversation = attrs["conversation.id"];
    if (typeof codexConversation === "string" && codexConversation.length > 0) {
      return codexConversation;
    }
    const codexThread = attrs["thread.id"];
    if (typeof codexThread === "string" && codexThread.length > 0) {
      return codexThread;
    }
    const codexThreadUnderscore = attrs.thread_id;
    if (
      typeof codexThreadUnderscore === "string" &&
      codexThreadUnderscore.length > 0
    ) {
      return codexThreadUnderscore;
    }
  }
  return null;
}

function readStringAttr(
  attrs: Record<string, unknown>,
  key: string,
): string | null {
  const v = attrs[key];
  return typeof v === "string" ? v : null;
}

function readFirstStringAttr(
  attrs: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = readStringAttr(attrs, key);
    if (value !== null) return value;
  }
  return null;
}

function readNumberAttr(
  attrs: Record<string, unknown>,
  key: string,
): number | null {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function readTokenAttr(
  attrs: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | null {
  for (const key of keys) {
    const value = readNumberAttr(attrs, key);
    if (value !== null) return value;
  }
  return null;
}

function isCodexTokenUsageSpan(name: string): boolean {
  return name === "codex.turn.token_usage";
}

function isCodexResponseOrStreamSpan(name: string): boolean {
  return (
    name === "codex.response" ||
    name === "codex.responses" ||
    name === "model_client.stream_responses" ||
    name === "model_client.stream_responses_websocket" ||
    name === "responses.stream_request" ||
    name === "responses_websocket.stream_request"
  );
}

function isCodexTurnSpan(name: string): boolean {
  return name === "session_task.turn";
}

/**
 * Token-carrying attribute keys we recognise on Codex response/stream spans.
 * A response/stream span counts as a usage source only when at least one of
 * these resolves to a finite number. Older Codex builds emitted tokens here;
 * newer builds may leave these blank and put usage exclusively on
 * `session_task.turn` as `codex.turn.token_usage.*` attributes.
 */
const RESPONSE_STREAM_USAGE_KEYS = [
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "input_tokens",
  "output_tokens",
] as const;

function spanHasResponseStreamUsage(attrs: Record<string, unknown>): boolean {
  for (const key of RESPONSE_STREAM_USAGE_KEYS) {
    if (readNumberAttr(attrs, key) !== null) return true;
  }
  return false;
}

export function analyzeTraceUsageSources(
  spans: ReadonlyArray<{ name: string; attributes?: Record<string, unknown> }>,
): TraceUsageSources {
  let hasCodexTokenUsage = false;
  let hasCodexResponseOrStreamWithUsage = false;

  for (const span of spans) {
    const attrs = span.attributes ?? {};
    if (isCodexTokenUsageSpan(span.name)) {
      hasCodexTokenUsage = true;
    }
    if (
      isCodexResponseOrStreamSpan(span.name) &&
      spanHasResponseStreamUsage(attrs)
    ) {
      hasCodexResponseOrStreamWithUsage = true;
    }
  }

  return { hasCodexTokenUsage, hasCodexResponseOrStreamWithUsage };
}

function shouldPromoteUsageColumns({
  kind,
  spanName,
  traceUsageSources,
}: Pick<
  ResolveSpanUsageColumnsInput,
  "kind" | "spanName" | "traceUsageSources"
>): boolean {
  if (isCodexTurnSpan(spanName)) {
    // session_task.turn is the lowest-priority fallback per ADR 2026042901:
    // only promote it when neither a `codex.turn.token_usage` span nor a
    // response/stream span carrying real token attrs is present in the trace.
    return (
      !traceUsageSources.hasCodexTokenUsage &&
      !traceUsageSources.hasCodexResponseOrStreamWithUsage
    );
  }
  if (kind !== "chat") return false;
  if (
    traceUsageSources.hasCodexTokenUsage &&
    isCodexResponseOrStreamSpan(spanName)
  ) {
    return false;
  }
  return true;
}

export function resolveSpanUsageColumns({
  kind,
  spanName,
  attrs,
  traceUsageSources,
}: ResolveSpanUsageColumnsInput): SpanUsageColumns {
  if (!shouldPromoteUsageColumns({ kind, spanName, traceUsageSources })) {
    return {
      model: null,
      inTok: null,
      outTok: null,
      cacheR: null,
      cacheW: null,
    };
  }

  return {
    model: readFirstStringAttr(attrs, [
      "gen_ai.response.model",
      "gen_ai.request.model",
      "model",
    ]),
    inTok: readTokenAttr(attrs, [
      "gen_ai.usage.input_tokens",
      "input_tokens",
      "codex.turn.token_usage.input_tokens",
    ]),
    outTok: readTokenAttr(attrs, [
      "gen_ai.usage.output_tokens",
      "output_tokens",
      "codex.turn.token_usage.output_tokens",
    ]),
    cacheR: readTokenAttr(attrs, [
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.cache_read_input_tokens",
      "cache_read_tokens",
      "codex.turn.token_usage.cache_read_input_tokens",
      "codex.turn.token_usage.cache_read.input_tokens",
    ]),
    cacheW: readTokenAttr(attrs, [
      "gen_ai.usage.cache_creation.input_tokens",
      "gen_ai.usage.cache_creation_input_tokens",
      "cache_creation_tokens",
      "codex.turn.token_usage.cache_creation_input_tokens",
      "codex.turn.token_usage.cache_creation.input_tokens",
    ]),
  };
}
