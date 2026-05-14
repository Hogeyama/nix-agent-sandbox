import { describe, expect, test } from "bun:test";
import type { LogRecordSummaryRow, SpanSummaryRow } from "../history/types";
import { extractTracePrompts } from "./prompts";

// Just enough of each agent's signal to make this aggregator-level test
// self-contained. The per-agent extractors are exhaustively tested in
// `claude_prompts_test.ts` / `copilot_prompts_test.ts`; this file asserts
// only the merge contract.

function claudeSpan(traceId: string, requestId: string): SpanSummaryRow {
  return {
    spanId: `llm_${traceId}`,
    parentSpanId: null,
    traceId,
    spanName: "claude_code.llm_request",
    kind: "client",
    model: null,
    inTok: 0,
    outTok: 0,
    cacheR: 0,
    cacheW: 0,
    durationMs: 0,
    startedAt: "2026-05-01T11:00:00.000Z",
    endedAt: "2026-05-01T11:00:05.000Z",
    attrsJson: JSON.stringify({ request_id: requestId }),
    eventsJson: null,
  };
}

function copilotSpan(traceId: string, prompt: string): SpanSummaryRow {
  return {
    spanId: `inv_${traceId}`,
    parentSpanId: null,
    traceId,
    spanName: "invoke_agent",
    kind: "invoke_agent",
    model: null,
    inTok: 0,
    outTok: 0,
    cacheR: 0,
    cacheW: 0,
    durationMs: 0,
    startedAt: "2026-05-01T11:00:00.000Z",
    endedAt: "2026-05-01T11:00:05.000Z",
    attrsJson: JSON.stringify({
      "gen_ai.input.messages": JSON.stringify([
        { role: "user", parts: [{ type: "text", content: prompt }] },
      ]),
    }),
    eventsJson: null,
  };
}

function apiRecord(requestId: string, promptId: string): LogRecordSummaryRow {
  return {
    invocationId: "inv_x",
    conversationId: "conv_x",
    promptId,
    sequence: 1,
    eventName: "api_request",
    time: "2026-05-01T11:00:00.000Z",
    requestId,
    attrsJson: "{}",
  };
}

function userPromptRecord(
  promptId: string,
  prompt: string,
): LogRecordSummaryRow {
  return {
    invocationId: "inv_x",
    conversationId: "conv_x",
    promptId,
    sequence: 0,
    eventName: "user_prompt",
    time: "2026-05-01T11:00:00.000Z",
    requestId: null,
    attrsJson: JSON.stringify({ prompt }),
  };
}

describe("extractTracePrompts (per-agent aggregator)", () => {
  test("Claude path resolves a trace", () => {
    const result = extractTracePrompts(
      [apiRecord("req_1", "p1"), userPromptRecord("p1", "claude text")],
      [claudeSpan("t_claude", "req_1")],
    );
    expect(result.get("t_claude")).toBe("claude text");
  });

  test("Copilot path resolves a trace", () => {
    const result = extractTracePrompts(
      [],
      [copilotSpan("t_copilot", "copilot text")],
    );
    expect(result.get("t_copilot")).toBe("copilot text");
  });

  test("traces from both agents coexist in one conversation", () => {
    const result = extractTracePrompts(
      [apiRecord("req_1", "p1"), userPromptRecord("p1", "claude text")],
      [
        claudeSpan("t_claude", "req_1"),
        copilotSpan("t_copilot", "copilot text"),
      ],
    );
    expect(result.get("t_claude")).toBe("claude text");
    expect(result.get("t_copilot")).toBe("copilot text");
  });

  test("Claude takes precedence over Copilot when both resolve for the same trace", () => {
    // Defensive: a single trace should never carry both signals in practice.
    // If it does, the log-records join wins (it carries the canonical
    // first-emission prompt — see ADR invariant).
    const result = extractTracePrompts(
      [apiRecord("req_1", "p1"), userPromptRecord("p1", "claude wins")],
      [claudeSpan("t_dual", "req_1"), copilotSpan("t_dual", "copilot loses")],
    );
    expect(result.get("t_dual")).toBe("claude wins");
  });

  test("empty inputs produce an empty map", () => {
    const result = extractTracePrompts([], []);
    expect(result.size).toBe(0);
  });
});
