import { describe, expect, test } from "bun:test";
import type {
  ConversationDetail,
  ConversationListRow,
  ConversationTurnEventRow,
  InvocationSummaryRow,
  SpanSummaryRow,
  TraceSummaryRow,
} from "../../../../../history/types";
import {
  buildConversationHeader,
  buildConversationTurnEventRows,
  buildInvocationLinks,
  buildSpanRows,
  buildTraceRows,
  buildTurnRows,
  compareTurnOrder,
  extractToolName,
  formatCountCell,
  formatDuration,
  formatTurnTokens,
  truncatePayload,
} from "./conversationDetailView";

const NOW_MS = Date.parse("2026-05-01T12:00:00.000Z");

function makeConversation(
  overrides: Partial<ConversationListRow> = {},
): ConversationListRow {
  return {
    id: "sess_aabbccdd11223344",
    agent: "claude-code",
    firstSeenAt: "2026-04-30T12:00:00.000Z",
    lastSeenAt: "2026-05-01T08:00:00.000Z",
    turnEventCount: 12,
    spanCount: 34,
    invocationCount: 2,
    inputTokensTotal: 1500,
    outputTokensTotal: 500,
    cacheReadTotal: 100,
    cacheWriteTotal: 50,
    summary: null,
    ...overrides,
  };
}

function makeInvocation(
  overrides: Partial<InvocationSummaryRow> = {},
): InvocationSummaryRow {
  return {
    id: "inv_xxxxxxxxxxxxxxxx",
    profile: "default",
    agent: "claude-code",
    worktreePath: "/work/repo",
    startedAt: "2026-05-01T11:00:00.000Z",
    endedAt: "2026-05-01T11:30:00.000Z",
    exitReason: "completed",
    ...overrides,
  };
}

function makeTrace(overrides: Partial<TraceSummaryRow> = {}): TraceSummaryRow {
  return {
    traceId: "trace_aabbccdd11223344",
    invocationId: "inv_xxxxxxxxxxxxxxxx",
    conversationId: "sess_aabbccdd11223344",
    startedAt: "2026-05-01T11:05:00.000Z",
    endedAt: "2026-05-01T11:15:00.000Z",
    spanCount: 7,
    ...overrides,
  };
}

function makeSpan(overrides: Partial<SpanSummaryRow> = {}): SpanSummaryRow {
  return {
    spanId: "span_aabbccdd11223344",
    parentSpanId: "span_parent999999",
    traceId: "trace_aabbccdd11223344",
    spanName: "chat.completion",
    kind: "client",
    model: "gpt-4",
    inTok: 100,
    outTok: 50,
    cacheR: 0,
    cacheW: 0,
    durationMs: 1234,
    startedAt: "2026-05-01T11:10:00.000Z",
    endedAt: "2026-05-01T11:10:05.000Z",
    attrsJson: "{}",
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<ConversationDetail> = {},
): ConversationDetail {
  return {
    conversation: makeConversation(),
    traces: [makeTrace()],
    spans: [makeSpan()],
    turnEvents: [],
    invocations: [makeInvocation()],
    ...overrides,
  };
}

describe("truncatePayload", () => {
  test("returns short payloads unchanged", () => {
    expect(truncatePayload(`{"k":"v"}`)).toBe(`{"k":"v"}`);
  });

  test("collapses internal whitespace", () => {
    expect(truncatePayload(`{\n  "k":   "v"\n}`)).toBe(`{ "k": "v" }`);
  });

  test("truncates long payloads with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = truncatePayload(long);
    expect(out.length).toBe(81); // 80 chars + ellipsis char
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("formatDuration", () => {
  test("null propagates as null so the page can choose blank rendering", () => {
    expect(formatDuration(null)).toBeNull();
  });
  test("sub-second durations render as integer ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(234)).toBe("234ms");
    expect(formatDuration(999)).toBe("999ms");
  });
  test("sub-minute durations render as decimal seconds, truncated", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(12_345)).toBe("12.3s");
    expect(formatDuration(59_999)).toBe("59.9s");
  });
  test("sub-hour durations render as <m>m<s>s with no leading zeros", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(84_000)).toBe("1m24s");
    expect(formatDuration(3_599_000)).toBe("59m59s");
  });
  test("hour-or-greater durations render as <h>h<m>m", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(4_980_000)).toBe("1h23m");
  });
});

describe("formatCountCell", () => {
  test("null becomes null so the row layout collapses to empty", () => {
    expect(formatCountCell(null)).toBeNull();
  });
  test("zero stays as the number, not the dash", () => {
    expect(formatCountCell(0)).toBe("0");
  });
  test("small values render as bare integers", () => {
    expect(formatCountCell(42)).toBe("42");
  });
  test("kilo-bucket values use compact form", () => {
    expect(formatCountCell(1500)).toBe("1.5k");
  });
});

describe("formatTurnTokens", () => {
  test("joins all four numeric kinds with ' · ' via compact formatter", () => {
    expect(
      formatTurnTokens({
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 1000,
        cacheWriteTokens: 50,
      }),
    ).toBe("100 · 200 · 1k · 50");
  });

  test("renders all four nulls as hyphen-minus placeholders", () => {
    expect(
      formatTurnTokens({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    ).toBe("- · - · - · -");
  });

  test("mixes numeric values and hyphen-minus placeholders for nulls", () => {
    expect(
      formatTurnTokens({
        inputTokens: 100,
        outputTokens: null,
        cacheReadTokens: 1000,
        cacheWriteTokens: null,
      }),
    ).toBe("100 · - · 1k · -");
  });
});

describe("buildConversationHeader", () => {
  test("projects every header field and sums input + output tokens", () => {
    const view = buildConversationHeader(makeDetail(), NOW_MS);
    expect(view.id).toBe("sess_aabbccdd11223344");
    expect(view.idLabel).toBe("sess_aab");
    expect(view.agent).toBe("claude-code");
    expect(view.firstSeen).toBe("yesterday");
    expect(view.lastSeen).toBe("4h ago");
    expect(view.summary).toBeNull();
    expect(view.turnCount).toBe(12);
    expect(view.spanCount).toBe(34);
    expect(view.invocationCount).toBe(2);
    expect(view.inputTokens).toBe(1500);
    expect(view.outputTokens).toBe(500);
    expect(view.cacheReadTokens).toBe(100);
    expect(view.cacheWriteTokens).toBe(50);
    expect(view.tokenTotal).toBe(2000);
  });

  test("propagates a null agent verbatim (no placeholder)", () => {
    const view = buildConversationHeader(
      makeDetail({ conversation: makeConversation({ agent: null }) }),
      NOW_MS,
    );
    expect(view.agent).toBeNull();
  });

  test("propagates a non-null summary verbatim", () => {
    const view = buildConversationHeader(
      makeDetail({
        conversation: makeConversation({ summary: "Refactor the auth flow" }),
      }),
      NOW_MS,
    );
    expect(view.summary).toBe("Refactor the auth flow");
  });

  test("tokenBar projects proportional split summing to 100", () => {
    const view = buildConversationHeader(
      makeDetail({
        conversation: makeConversation({
          inputTokensTotal: 750,
          outputTokensTotal: 250,
          cacheReadTotal: 0,
          cacheWriteTotal: 0,
        }),
      }),
      NOW_MS,
    );
    expect(view.tokenBar).not.toBeNull();
    expect(view.tokenBar?.inputPct).toBe(75);
    expect(view.tokenBar?.outputPct).toBe(25);
    expect(view.tokenBar?.cacheReadPct).toBe(0);
    expect(view.tokenBar?.cacheWritePct).toBe(0);
  });

  test("tokenBar is null when every kind is zero", () => {
    const view = buildConversationHeader(
      makeDetail({
        conversation: makeConversation({
          inputTokensTotal: 0,
          outputTokensTotal: 0,
          cacheReadTotal: 0,
          cacheWriteTotal: 0,
        }),
      }),
      NOW_MS,
    );
    expect(view.tokenBar).toBeNull();
  });
});

describe("buildInvocationLinks", () => {
  test("returns one row per invocation with encoded hrefs", () => {
    const view = buildInvocationLinks(makeDetail(), NOW_MS);
    expect(view).toHaveLength(1);
    expect(view[0]?.idLabel).toBe("inv_xxxx");
    expect(view[0]?.href).toBe("#/history/invocation/inv_xxxxxxxxxxxxxxxx");
    expect(view[0]?.profile).toBe("default");
    expect(view[0]?.worktreePath).toBe("/work/repo");
    expect(view[0]?.exitReason).toBe("completed");
    expect(view[0]?.endedAt).not.toBeNull();
  });

  test("returns an empty array when no invocations are present", () => {
    const view = buildInvocationLinks(makeDetail({ invocations: [] }), NOW_MS);
    expect(view).toEqual([]);
  });

  test("running invocation surfaces null endedAt and null exitReason", () => {
    const view = buildInvocationLinks(
      makeDetail({
        invocations: [makeInvocation({ endedAt: null, exitReason: null })],
      }),
      NOW_MS,
    );
    expect(view[0]?.endedAt).toBeNull();
    expect(view[0]?.endedAtAbsolute).toBeNull();
    expect(view[0]?.exitReason).toBeNull();
  });

  test("null profile flows through as null", () => {
    const view = buildInvocationLinks(
      makeDetail({ invocations: [makeInvocation({ profile: null })] }),
      NOW_MS,
    );
    expect(view[0]?.profile).toBeNull();
  });

  test("encodes hash-unsafe ids", () => {
    const view = buildInvocationLinks(
      makeDetail({ invocations: [makeInvocation({ id: "inv with space" })] }),
      NOW_MS,
    );
    expect(view[0]?.href).toBe("#/history/invocation/inv%20with%20space");
  });
});

describe("buildTraceRows", () => {
  test("projects each trace into a row with an invocation href", () => {
    const view = buildTraceRows([makeTrace()], NOW_MS);
    expect(view).toHaveLength(1);
    expect(view[0]?.traceIdLabel).toBe("trace_aa");
    expect(view[0]?.invocationHref).toBe(
      "#/history/invocation/inv_xxxxxxxxxxxxxxxx",
    );
    expect(view[0]?.spanCount).toBe(7);
    expect(view[0]?.endedAt).not.toBeNull();
  });

  test("renders an open trace as a null endedAt", () => {
    const view = buildTraceRows([makeTrace({ endedAt: null })], NOW_MS);
    expect(view[0]?.endedAt).toBeNull();
    expect(view[0]?.endedAtAbsolute).toBeNull();
  });

  test("returns empty for an empty input", () => {
    expect(buildTraceRows([], NOW_MS)).toEqual([]);
  });
});

describe("buildSpanRows", () => {
  test("projects each span and propagates null cells verbatim", () => {
    const view = buildSpanRows(
      [
        makeSpan({
          parentSpanId: null,
          model: null,
          inTok: null,
          outTok: null,
          durationMs: null,
        }),
      ],
      NOW_MS,
    );
    expect(view[0]?.parentSpanIdLabel).toBeNull();
    expect(view[0]?.model).toBeNull();
    expect(view[0]?.inTok).toBeNull();
    expect(view[0]?.outTok).toBeNull();
    expect(view[0]?.durationLabel).toBeNull();
  });

  test("renders populated cells with compact and short formatters", () => {
    const view = buildSpanRows([makeSpan()], NOW_MS);
    expect(view[0]?.parentSpanIdLabel).toBe("span_par");
    expect(view[0]?.model).toBe("gpt-4");
    expect(view[0]?.inTok).toBe("100");
    expect(view[0]?.outTok).toBe("50");
    expect(view[0]?.durationLabel).toBe("1.2s");
  });

  test("ioCell joins in/out with a slash and cache cell empty when both zero", () => {
    const view = buildSpanRows(
      [makeSpan({ inTok: 1500, outTok: 500, cacheR: 0, cacheW: 0 })],
      NOW_MS,
    );
    expect(view[0]?.ioCell).toBe("1.5k / 500");
    // cacheR and cacheW are both 0 (not null) so the cell still renders both halves.
    expect(view[0]?.cacheCell).toBe("0 / 0");
  });

  test("ioCell collapses to empty string when both halves are null", () => {
    const view = buildSpanRows(
      [makeSpan({ inTok: null, outTok: null, cacheR: null, cacheW: null })],
      NOW_MS,
    );
    expect(view[0]?.ioCell).toBe("");
    expect(view[0]?.cacheCell).toBe("");
  });

  test("ioCell uses em-dash placeholder when one half is null", () => {
    const view = buildSpanRows(
      [makeSpan({ inTok: 100, outTok: null, cacheR: null, cacheW: 50 })],
      NOW_MS,
    );
    expect(view[0]?.ioCell).toBe("100 / —");
    expect(view[0]?.cacheCell).toBe("— / 50");
  });

  test("classifies a chat.completion span as the chat variant", () => {
    const view = buildSpanRows([makeSpan()], NOW_MS);
    expect(view[0]?.kindLabel).toBe("chat");
    expect(view[0]?.kindClass).toBe("is-chat");
  });

  test("classifies a tool.invoke span as the tool variant", () => {
    const view = buildSpanRows([makeSpan({ spanName: "tool.invoke" })], NOW_MS);
    expect(view[0]?.kindLabel).toBe("tool");
    expect(view[0]?.kindClass).toBe("is-tool");
  });

  test("classifies an agent.run span as the agent variant", () => {
    const view = buildSpanRows([makeSpan({ spanName: "agent.run" })], NOW_MS);
    expect(view[0]?.kindLabel).toBe("agent");
    expect(view[0]?.kindClass).toBe("is-agent");
  });

  test("falls back to raw kind with no class for unrecognised spans", () => {
    const view = buildSpanRows(
      [makeSpan({ spanName: "weirdo", kind: "producer" })],
      NOW_MS,
    );
    expect(view[0]?.kindLabel).toBe("producer");
    expect(view[0]?.kindClass).toBe("");
  });

  test("toolName is populated for execute_tool spans with tool_name attr", () => {
    const view = buildSpanRows(
      [
        makeSpan({
          kind: "execute_tool",
          attrsJson: JSON.stringify({ tool_name: "Bash" }),
        }),
      ],
      NOW_MS,
    );
    expect(view[0]?.toolName).toBe("Bash");
  });

  test("toolName is null for non-execute_tool spans (e.g. chat)", () => {
    const view = buildSpanRows([makeSpan()], NOW_MS);
    expect(view[0]?.toolName).toBeNull();
  });

  test("attrsPretty re-serialises valid JSON with 2-space indent (round-trips)", () => {
    const view = buildSpanRows(
      [makeSpan({ attrsJson: JSON.stringify({ a: 1, b: { c: 2 } }) })],
      NOW_MS,
    );
    const pretty = view[0]?.attrsPretty ?? "";
    expect(pretty).toContain("\n");
    expect(pretty).toContain('  "a": 1');
    expect(JSON.parse(pretty)).toEqual({ a: 1, b: { c: 2 } });
  });

  test("attrsPretty passes malformed JSON through verbatim (no info loss)", () => {
    const view = buildSpanRows([makeSpan({ attrsJson: "{not valid" })], NOW_MS);
    expect(view[0]?.attrsPretty).toBe("{not valid");
  });

  test("attrsPretty collapses empty string to '{}' literal", () => {
    const view = buildSpanRows([makeSpan({ attrsJson: "" })], NOW_MS);
    expect(view[0]?.attrsPretty).toBe("{}");
  });

  test("attrsPretty collapses '{}' to '{}' literal (not '{\\n}')", () => {
    const view = buildSpanRows([makeSpan({ attrsJson: "{}" })], NOW_MS);
    expect(view[0]?.attrsPretty).toBe("{}");
  });
});

describe("extractToolName", () => {
  test("returns null for chat spans even when attrs carry a tool_name", () => {
    const span = makeSpan({
      kind: "chat",
      attrsJson: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(extractToolName(span)).toBeNull();
  });

  test("reads tool_name from execute_tool attrs", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(extractToolName(span)).toBe("Bash");
  });

  test("reads gen_ai.tool.name from execute_tool attrs", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({ "gen_ai.tool.name": "shell" }),
    });
    expect(extractToolName(span)).toBe("shell");
  });

  test("reads claude_code.tool.name from execute_tool attrs", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({ "claude_code.tool.name": "Read" }),
    });
    expect(extractToolName(span)).toBe("Read");
  });

  test("falls back to `execute_tool <name>` span-name regex (Copilot)", () => {
    const span = makeSpan({
      kind: "execute_tool",
      spanName: "execute_tool shell",
      attrsJson: "{}",
    });
    expect(extractToolName(span)).toBe("shell");
  });

  test("falls back to `claude_code.tool.<subtype>` span-name regex", () => {
    const span = makeSpan({
      kind: "execute_tool",
      spanName: "claude_code.tool.execution",
      attrsJson: "{}",
    });
    expect(extractToolName(span)).toBe("execution");
  });

  test("returns null when span name has no extractable suffix", () => {
    const span = makeSpan({
      kind: "execute_tool",
      spanName: "claude_code.tool",
      attrsJson: "{}",
    });
    expect(extractToolName(span)).toBeNull();
  });

  test("returns null when attrsJson is malformed (no crash)", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: "{not valid json",
    });
    expect(extractToolName(span)).toBeNull();
  });

  test("prefers tool_name over gen_ai.tool.name when both are present", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({
        tool_name: "Bash",
        "gen_ai.tool.name": "shell",
      }),
    });
    expect(extractToolName(span)).toBe("Bash");
  });

  test("array attrs fall through to span-name regex", () => {
    const span = makeSpan({
      kind: "execute_tool",
      spanName: "execute_tool shell",
      attrsJson: "[]",
    });
    expect(extractToolName(span)).toBe("shell");
  });

  test("non-object attrs (number) fall through to span-name regex", () => {
    const span = makeSpan({
      kind: "execute_tool",
      spanName: "execute_tool shell",
      attrsJson: "42",
    });
    expect(extractToolName(span)).toBe("shell");
  });

  test("empty-string tool_name falls through to next attr key", () => {
    const span = makeSpan({
      kind: "execute_tool",
      spanName: "x",
      attrsJson: JSON.stringify({
        tool_name: "",
        "gen_ai.tool.name": "shell",
      }),
    });
    expect(extractToolName(span)).toBe("shell");
  });

  test("non-string tool_name falls through to next attr key", () => {
    const span = makeSpan({
      kind: "execute_tool",
      spanName: "x",
      attrsJson: JSON.stringify({
        tool_name: 123,
        "gen_ai.tool.name": "shell",
      }),
    });
    expect(extractToolName(span)).toBe("shell");
  });
});

describe("buildConversationTurnEventRows", () => {
  function makeEvent(
    overrides: Partial<ConversationTurnEventRow> = {},
  ): ConversationTurnEventRow {
    return {
      invocationId: "inv_xxxxxxxxxxxxxxxx",
      ts: "2026-05-01T11:30:00.000Z",
      kind: "user_message",
      payloadJson: `{"text":"hello"}`,
      ...overrides,
    };
  }

  test("returns empty for no events", () => {
    expect(buildConversationTurnEventRows([], NOW_MS)).toEqual([]);
  });

  test("projects a single event with truncated payload preview", () => {
    const huge = "y".repeat(200);
    const view = buildConversationTurnEventRows(
      [makeEvent({ payloadJson: huge })],
      NOW_MS,
    );
    expect(view[0]?.linkIdLabel).toBe("inv_xxxx");
    expect(view[0]?.linkHref).toBe("#/history/invocation/inv_xxxxxxxxxxxxxxxx");
    expect(view[0]?.kind).toBe("user_message");
    expect(view[0]?.payloadPreview.endsWith("…")).toBe(true);
  });
});

describe("compareTurnOrder", () => {
  test("orders by startedAt ascending", () => {
    const earlier = { startedAt: "2026-05-01T11:00:00.000Z", traceId: "z" };
    const later = { startedAt: "2026-05-01T12:00:00.000Z", traceId: "a" };
    expect(compareTurnOrder(earlier, later)).toBeLessThan(0);
    expect(compareTurnOrder(later, earlier)).toBeGreaterThan(0);
  });

  test("uses traceId lexicographic ascending as tie-breaker", () => {
    const a = { startedAt: "2026-05-01T11:00:00.000Z", traceId: "a" };
    const b = { startedAt: "2026-05-01T11:00:00.000Z", traceId: "b" };
    expect(compareTurnOrder(a, b)).toBeLessThan(0);
    expect(compareTurnOrder(b, a)).toBeGreaterThan(0);
  });

  test("equal startedAt and traceId compare equal", () => {
    const a = { startedAt: "2026-05-01T11:00:00.000Z", traceId: "x" };
    const b = { startedAt: "2026-05-01T11:00:00.000Z", traceId: "x" };
    expect(compareTurnOrder(a, b)).toBe(0);
  });
});

describe("buildTurnRows", () => {
  test("aggregates chat / tool counts and token totals across spans of one trace", () => {
    const detail = makeDetail({
      traces: [
        makeTrace({
          traceId: "trace_one",
          startedAt: "2026-05-01T11:00:00.000Z",
          endedAt: "2026-05-01T11:00:01.234Z",
        }),
      ],
      spans: [
        makeSpan({
          spanId: "s1",
          traceId: "trace_one",
          kind: "chat",
          inTok: 100,
          outTok: 50,
          cacheR: 10,
          cacheW: 5,
        }),
        makeSpan({
          spanId: "s2",
          traceId: "trace_one",
          kind: "execute_tool",
          inTok: 1,
          outTok: 2,
          cacheR: 3,
          cacheW: 4,
        }),
        makeSpan({
          spanId: "s3",
          traceId: "trace_one",
          kind: "execute_tool",
          inTok: 7,
          outTok: 8,
          cacheR: 9,
          cacheW: 11,
        }),
      ],
    });
    const view = buildTurnRows(detail, NOW_MS);
    expect(view).toHaveLength(1);
    expect(view[0]?.llmCount).toBe(1);
    expect(view[0]?.toolCount).toBe(2);
    expect(view[0]?.spanCount).toBe(3);
    expect(view[0]?.inputTokens).toBe(108);
    expect(view[0]?.outputTokens).toBe(60);
    expect(view[0]?.cacheReadTokens).toBe(22);
    expect(view[0]?.cacheWriteTokens).toBe(20);
    expect(view[0]?.durationLabel).toBe("1.2s");
    expect(view[0]?.traceIdLabel).toBe("trace_on");
    expect(view[0]?.invocationHref).toBe(
      "#/history/invocation/inv_xxxxxxxxxxxxxxxx",
    );
  });

  test("open trace renders durationLabel as empty string", () => {
    const detail = makeDetail({
      traces: [makeTrace({ endedAt: null })],
      spans: [],
    });
    const view = buildTurnRows(detail, NOW_MS);
    expect(view[0]?.durationLabel).toBe("");
  });

  test("token kind that is null on every span surfaces as null (not 0)", () => {
    const detail = makeDetail({
      traces: [makeTrace()],
      spans: [
        makeSpan({ spanId: "s1", inTok: null, outTok: 10 }),
        makeSpan({ spanId: "s2", inTok: null, outTok: 20 }),
      ],
    });
    const view = buildTurnRows(detail, NOW_MS);
    expect(view[0]?.inputTokens).toBeNull();
    expect(view[0]?.outputTokens).toBe(30);
  });

  test("mixed null / numeric token entries sum only the numerics", () => {
    const detail = makeDetail({
      traces: [makeTrace()],
      spans: [
        makeSpan({ spanId: "s1", inTok: null }),
        makeSpan({ spanId: "s2", inTok: 100 }),
        makeSpan({ spanId: "s3", inTok: 23 }),
      ],
    });
    const view = buildTurnRows(detail, NOW_MS);
    expect(view[0]?.inputTokens).toBe(123);
  });

  test("spans are partitioned by traceId across multiple traces", () => {
    const detail = makeDetail({
      traces: [
        makeTrace({
          traceId: "trace_a",
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
        makeTrace({
          traceId: "trace_b",
          startedAt: "2026-05-01T11:01:00.000Z",
        }),
      ],
      spans: [
        makeSpan({ spanId: "s1", traceId: "trace_a", kind: "chat" }),
        makeSpan({
          spanId: "s2",
          traceId: "trace_b",
          kind: "execute_tool",
        }),
        makeSpan({
          spanId: "s3",
          traceId: "trace_b",
          kind: "execute_tool",
        }),
      ],
    });
    const view = buildTurnRows(detail, NOW_MS);
    expect(view[0]?.traceId).toBe("trace_a");
    expect(view[0]?.llmCount).toBe(1);
    expect(view[0]?.toolCount).toBe(0);
    expect(view[0]?.spanCount).toBe(1);
    expect(view[1]?.traceId).toBe("trace_b");
    expect(view[1]?.llmCount).toBe(0);
    expect(view[1]?.toolCount).toBe(2);
    expect(view[1]?.spanCount).toBe(2);
  });

  test("turn with no chat / tool spans reports zero counts", () => {
    const detail = makeDetail({
      traces: [makeTrace()],
      spans: [makeSpan({ kind: "other" })],
    });
    const view = buildTurnRows(detail, NOW_MS);
    expect(view[0]?.llmCount).toBe(0);
    expect(view[0]?.toolCount).toBe(0);
    expect(view[0]?.spanCount).toBe(1);
  });

  test("turn with no spans at all reports zero counts and null tokens", () => {
    const detail = makeDetail({
      traces: [makeTrace()],
      spans: [],
    });
    const view = buildTurnRows(detail, NOW_MS);
    expect(view[0]?.llmCount).toBe(0);
    expect(view[0]?.toolCount).toBe(0);
    expect(view[0]?.spanCount).toBe(0);
    expect(view[0]?.inputTokens).toBeNull();
    expect(view[0]?.outputTokens).toBeNull();
    expect(view[0]?.cacheReadTokens).toBeNull();
    expect(view[0]?.cacheWriteTokens).toBeNull();
  });

  test("traces in reverse order are sorted by startedAt ASC", () => {
    const detail = makeDetail({
      traces: [
        makeTrace({
          traceId: "trace_late",
          startedAt: "2026-05-01T12:00:00.000Z",
        }),
        makeTrace({
          traceId: "trace_early",
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
      ],
      spans: [],
    });
    const view = buildTurnRows(detail, NOW_MS);
    expect(view[0]?.traceId).toBe("trace_early");
    expect(view[1]?.traceId).toBe("trace_late");
  });
});
