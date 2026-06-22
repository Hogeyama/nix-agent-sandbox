import { describe, expect, spyOn, test } from "bun:test";
import type { LogRecordSummaryRow, SpanSummaryRow } from "../history/types";
import {
  buildClaudePromptToTraceMap,
  extractClaudeTracePrompts,
} from "./claude_prompts";

// Helpers
//
// Build a complete join chain for a single trace:
//   traceId ← span claude_code.llm_request (request_id="req_*")
//     ← api_request log record (requestId="req_*", promptId="p_*")
//     ← user_prompt log record (promptId="p_*", attrs.prompt="…")

function makeLlmRequestSpan(
  traceId: string,
  requestId: string,
  overrides: Partial<SpanSummaryRow> = {},
): SpanSummaryRow {
  return {
    spanId: `llm_${traceId}`,
    parentSpanId: null,
    traceId,
    spanName: "claude_code.llm_request",
    kind: "client",
    model: null,
    inTok: 10,
    outTok: 5,
    cacheR: 0,
    cacheW: 0,
    durationMs: 100,
    startedAt: "2026-05-01T11:00:00.000Z",
    endedAt: "2026-05-01T11:00:05.000Z",
    attrsJson: JSON.stringify({ request_id: requestId }),
    eventsJson: null,
    ...overrides,
  };
}

function makeApiRequestRecord(
  requestId: string,
  promptId: string,
  sequence: number,
): LogRecordSummaryRow {
  return {
    invocationId: "inv_x",
    conversationId: "conv_x",
    promptId,
    sequence,
    eventName: "api_request",
    time: "2026-05-01T11:00:00.000Z",
    requestId,
    attrsJson: "{}",
  };
}

function makeUserPromptRecord(
  promptId: string,
  prompt: string,
  sequence: number,
): LogRecordSummaryRow {
  return {
    invocationId: "inv_x",
    conversationId: "conv_x",
    promptId,
    sequence,
    eventName: "user_prompt",
    time: "2026-05-01T11:00:00.000Z",
    requestId: null,
    attrsJson: JSON.stringify({ prompt }),
  };
}

describe("extractClaudeTracePrompts", () => {
  test("resolves traceId → prompt when the full join chain is present", () => {
    const result = extractClaudeTracePrompts(
      [
        makeApiRequestRecord("req_1", "p1", 1),
        makeUserPromptRecord("p1", "Hello world", 0),
      ],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.get("t1")).toBe("Hello world");
  });

  test("returns empty map when logRecords is empty", () => {
    const result = extractClaudeTracePrompts(
      [],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.size).toBe(0);
  });

  test("no entry when api_request record is missing", () => {
    const result = extractClaudeTracePrompts(
      [makeUserPromptRecord("p1", "should not resolve", 0)],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.has("t1")).toBe(false);
  });

  test("no entry when user_prompt record is missing", () => {
    const result = extractClaudeTracePrompts(
      [makeApiRequestRecord("req_1", "p1", 1)],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.has("t1")).toBe(false);
  });

  test("no entry when claude_code.llm_request span is missing", () => {
    const otherSpan: SpanSummaryRow = {
      ...makeLlmRequestSpan("t1", "req_1"),
      spanName: "chat.completion",
      kind: "chat",
      attrsJson: "{}",
    };
    const result = extractClaudeTracePrompts(
      [
        makeApiRequestRecord("req_1", "p1", 1),
        makeUserPromptRecord("p1", "should not resolve", 0),
      ],
      [otherSpan],
    );
    expect(result.has("t1")).toBe(false);
  });

  test("multiple traces map to their own prompts (no cross-contamination)", () => {
    const result = extractClaudeTracePrompts(
      [
        makeApiRequestRecord("req_a", "p_a", 1),
        makeApiRequestRecord("req_b", "p_b", 3),
        makeUserPromptRecord("p_a", "Turn A prompt", 0),
        makeUserPromptRecord("p_b", "Turn B prompt", 2),
      ],
      [
        makeLlmRequestSpan("t_a", "req_a"),
        makeLlmRequestSpan("t_b", "req_b", { spanId: "llm_t_b" }),
      ],
    );
    expect(result.get("t_a")).toBe("Turn A prompt");
    expect(result.get("t_b")).toBe("Turn B prompt");
  });

  test("when multiple user_prompt records share a promptId, lowest sequence wins", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = extractClaudeTracePrompts(
        [
          makeApiRequestRecord("req_1", "p1", 1),
          makeUserPromptRecord("p1", "Later duplicate", 5),
          makeUserPromptRecord("p1", "First canonical", 0),
        ],
        [makeLlmRequestSpan("t1", "req_1")],
      );
      expect(result.get("t1")).toBe("First canonical");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("duplicate user_prompt");
      expect(warnSpy.mock.calls[0]?.[0]).toContain("promptId=p1");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("when multiple api_request records share a requestId, lowest sequence wins", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = extractClaudeTracePrompts(
        [
          makeApiRequestRecord("req_1", "p_later", 5),
          makeApiRequestRecord("req_1", "p_first", 0),
          makeUserPromptRecord("p_later", "Should not resolve", 2),
          makeUserPromptRecord("p_first", "First canonical api", 1),
        ],
        [makeLlmRequestSpan("t1", "req_1")],
      );
      expect(result.get("t1")).toBe("First canonical api");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("duplicate api_request");
      expect(warnSpy.mock.calls[0]?.[0]).toContain("requestId=req_1");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("handles non-ASCII prompt text correctly", () => {
    const result = extractClaudeTracePrompts(
      [
        makeApiRequestRecord("req_1", "p1", 1),
        makeUserPromptRecord("p1", "日本語のプロンプト 🎉", 0),
      ],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.get("t1")).toBe("日本語のプロンプト 🎉");
  });

  test("sequence=0 is a valid sequence value (not treated as falsy)", () => {
    const result = extractClaudeTracePrompts(
      [
        makeApiRequestRecord("req_1", "p1", 1),
        makeUserPromptRecord("p1", "Prompt at sequence zero", 0),
      ],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.get("t1")).toBe("Prompt at sequence zero");
  });

  test("malformed attrs_json on llm_request span is skipped silently", () => {
    const result = extractClaudeTracePrompts(
      [
        makeApiRequestRecord("req_1", "p1", 1),
        makeUserPromptRecord("p1", "Hello", 0),
      ],
      [makeLlmRequestSpan("t1", "req_1", { attrsJson: "not-json" })],
    );
    expect(result.has("t1")).toBe(false);
  });

  test("malformed attrs_json on user_prompt record is skipped silently", () => {
    const result = extractClaudeTracePrompts(
      [
        makeApiRequestRecord("req_1", "p1", 1),
        { ...makeUserPromptRecord("p1", "ignored", 0), attrsJson: "not-json" },
      ],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.has("t1")).toBe(false);
  });

  test("api_request with null requestId is ignored", () => {
    const result = extractClaudeTracePrompts(
      [
        { ...makeApiRequestRecord("req_1", "p1", 1), requestId: null },
        makeUserPromptRecord("p1", "Hello", 0),
      ],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.has("t1")).toBe(false);
  });
});

describe("buildClaudePromptToTraceMap", () => {
  test("resolves promptId → traceId when the join chain is present", () => {
    const result = buildClaudePromptToTraceMap(
      [makeApiRequestRecord("req_1", "p1", 1)],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.get("p1")).toBe("t1");
  });

  test("returns empty map when both inputs are empty", () => {
    const result = buildClaudePromptToTraceMap([], []);
    expect(result.size).toBe(0);
  });

  test("returns empty map when logRecords is empty", () => {
    const result = buildClaudePromptToTraceMap(
      [],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.size).toBe(0);
  });

  test("returns empty map when spans is empty", () => {
    const result = buildClaudePromptToTraceMap(
      [makeApiRequestRecord("req_1", "p1", 1)],
      [],
    );
    expect(result.size).toBe(0);
  });

  test("no entry when api_request record is missing for the requestId", () => {
    // Only a user_prompt record exists — no api_request to link requestId → promptId
    const result = buildClaudePromptToTraceMap(
      [makeUserPromptRecord("p1", "some prompt", 0)],
      [makeLlmRequestSpan("t1", "req_1")],
    );
    expect(result.size).toBe(0);
  });

  test("no entry when llm_request span is missing", () => {
    const otherSpan: SpanSummaryRow = {
      ...makeLlmRequestSpan("t1", "req_1"),
      spanName: "chat.completion",
      attrsJson: "{}",
    };
    const result = buildClaudePromptToTraceMap(
      [makeApiRequestRecord("req_1", "p1", 1)],
      [otherSpan],
    );
    expect(result.size).toBe(0);
  });

  test("duplicate api_request records: lowest sequence wins", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = buildClaudePromptToTraceMap(
        [
          makeApiRequestRecord("req_1", "p_later", 5),
          makeApiRequestRecord("req_1", "p_first", 0),
        ],
        [makeLlmRequestSpan("t1", "req_1")],
      );
      // The api_request with sequence=0 maps req_1 → p_first
      expect(result.get("p_first")).toBe("t1");
      expect(result.has("p_later")).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("malformed attrsJson on llm_request span is skipped silently", () => {
    const result = buildClaudePromptToTraceMap(
      [makeApiRequestRecord("req_1", "p1", 1)],
      [makeLlmRequestSpan("t1", "req_1", { attrsJson: "not-json" })],
    );
    expect(result.size).toBe(0);
  });

  test("multiple traces map to distinct promptIds", () => {
    const result = buildClaudePromptToTraceMap(
      [
        makeApiRequestRecord("req_a", "p_a", 1),
        makeApiRequestRecord("req_b", "p_b", 3),
      ],
      [
        makeLlmRequestSpan("t_a", "req_a"),
        makeLlmRequestSpan("t_b", "req_b", { spanId: "llm_t_b" }),
      ],
    );
    expect(result.get("p_a")).toBe("t_a");
    expect(result.get("p_b")).toBe("t_b");
    expect(result.size).toBe(2);
  });

  test("when multiple requestIds map to the same promptId, first encountered wins", () => {
    // Two different requestIds both resolve to promptId "p_shared"
    const result = buildClaudePromptToTraceMap(
      [
        makeApiRequestRecord("req_1", "p_shared", 1),
        makeApiRequestRecord("req_2", "p_shared", 2),
      ],
      [
        makeLlmRequestSpan("t_first", "req_1"),
        makeLlmRequestSpan("t_second", "req_2", { spanId: "llm_t_second" }),
      ],
    );
    expect(result.get("p_shared")).toBe("t_first");
    expect(result.size).toBe(1);
  });
});
