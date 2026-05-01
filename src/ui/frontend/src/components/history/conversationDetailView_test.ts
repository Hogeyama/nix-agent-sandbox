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
  formatCountCell,
  formatDuration,
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
