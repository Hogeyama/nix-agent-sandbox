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

  // Layer 4: Copilot CLI `<op> <subject>` whitespace-prefixed names.
  if (name.startsWith("chat ")) return "chat";
  if (name.startsWith("execute_tool ")) return "execute_tool";
  if (name.startsWith("invoke_agent ")) return "invoke_agent";

  // Layer 5: presence of gen_ai.system marks the span as a chat regardless
  // of an unrecognised name (catches vendor-specific naming we don't model).
  if (typeof attrs["gen_ai.system"] === "string") {
    return "chat";
  }

  // Layer 6: fallback.
  return "other";
}
