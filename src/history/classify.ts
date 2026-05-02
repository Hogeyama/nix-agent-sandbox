/**
 * Span classification for the OTLP ingester.
 *
 * Implements the 6-layer priority order from ADR 2026042901
 * §"Span classification". The first layer that matches wins; lower layers
 * are not consulted. Pure function, no I/O.
 */

export type SpanKind = "chat" | "execute_tool" | "invoke_agent" | "other";

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
