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
  formatDurationMs,
  formatTokenCell,
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

describe("formatDurationMs", () => {
  test("renders null as the dash placeholder", () => {
    expect(formatDurationMs(null)).toBe("—");
  });
  test("renders a number with the ms suffix", () => {
    expect(formatDurationMs(1234)).toBe("1234ms");
  });
});

describe("formatTokenCell", () => {
  test("null becomes the dash placeholder", () => {
    expect(formatTokenCell(null)).toBe("—");
  });
  test("zero stays as the number, not the dash", () => {
    expect(formatTokenCell(0)).toBe("0");
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
    expect(view.turnCount).toBe(12);
    expect(view.spanCount).toBe(34);
    expect(view.invocationCount).toBe(2);
    expect(view.inputTokens).toBe(1500);
    expect(view.outputTokens).toBe(500);
    expect(view.cacheReadTokens).toBe(100);
    expect(view.cacheWriteTokens).toBe(50);
    expect(view.tokenTotal).toBe(2000);
  });

  test("renders a null agent as the (unknown) placeholder", () => {
    const view = buildConversationHeader(
      makeDetail({ conversation: makeConversation({ agent: null }) }),
      NOW_MS,
    );
    expect(view.agent).toBe("(unknown)");
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
    expect(view[0]?.endedAt).not.toBe("(running)");
  });

  test("returns an empty array when no invocations are present", () => {
    const view = buildInvocationLinks(makeDetail({ invocations: [] }), NOW_MS);
    expect(view).toEqual([]);
  });

  test("renders a running invocation with the (running) placeholder", () => {
    const view = buildInvocationLinks(
      makeDetail({
        invocations: [makeInvocation({ endedAt: null, exitReason: null })],
      }),
      NOW_MS,
    );
    expect(view[0]?.endedAt).toBe("(running)");
    expect(view[0]?.exitReason).toBe("(unknown)");
  });

  test("substitutes (none) for a null profile", () => {
    const view = buildInvocationLinks(
      makeDetail({ invocations: [makeInvocation({ profile: null })] }),
      NOW_MS,
    );
    expect(view[0]?.profile).toBe("(none)");
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
    expect(view[0]?.endedAt).not.toBe("(running)");
  });

  test("renders an open trace as (running)", () => {
    const view = buildTraceRows([makeTrace({ endedAt: null })], NOW_MS);
    expect(view[0]?.endedAt).toBe("(running)");
  });

  test("returns empty for an empty input", () => {
    expect(buildTraceRows([], NOW_MS)).toEqual([]);
  });
});

describe("buildSpanRows", () => {
  test("projects each span and renders nullable cells with placeholders", () => {
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
    expect(view[0]?.parentSpanIdLabel).toBe("—");
    expect(view[0]?.model).toBe("—");
    expect(view[0]?.inTok).toBe("—");
    expect(view[0]?.outTok).toBe("—");
    expect(view[0]?.durationMs).toBe("—");
  });

  test("renders populated cells verbatim", () => {
    const view = buildSpanRows([makeSpan()], NOW_MS);
    expect(view[0]?.parentSpanIdLabel).toBe("span_par");
    expect(view[0]?.model).toBe("gpt-4");
    expect(view[0]?.inTok).toBe("100");
    expect(view[0]?.outTok).toBe("50");
    expect(view[0]?.durationMs).toBe("1234ms");
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
