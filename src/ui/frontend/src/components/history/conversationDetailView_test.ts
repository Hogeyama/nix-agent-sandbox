import { describe, expect, test } from "bun:test";
import type {
  ConversationDetail,
  ConversationListRow,
  InvocationSummaryRow,
  SpanSummaryRow,
  TraceSummaryRow,
} from "../../../../../history/types";
import {
  buildConversationHeader,
  buildInvocationLinks,
  buildSpanRows,
  buildSpanTreeByTurn,
  buildTraceRows,
  compareTurnOrder,
  extractToolDetail,
  extractToolName,
  formatCountCell,
  formatDuration,
  summariseTraceSpansByModel,
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
    worktreePath: null,
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
    modelTokenTotals: [],
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
  test("projects every visible header field", () => {
    const view = buildConversationHeader(makeDetail(), NOW_MS);
    expect(view.id).toBe("sess_aabbccdd11223344");
    expect(view.idLabel).toBe("sess_aab");
    expect(view.agent).toBe("claude-code");
    expect(view.firstSeen).toBe("yesterday");
    expect(view.lastSeen).toBe("4h ago");
    expect(view.summary).toBeNull();
    // Header turn count reflects displayed (zero-token-filtered) turns,
    // not the raw `turnEventCount`, so it matches the Turns table.
    expect(view.turnCount).toBe(1);
    expect(view.spanCount).toBe(34);
    expect(view.invocationCount).toBe(2);
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

  test("derives the project directory from the conversation worktreePath", () => {
    const view = buildConversationHeader(
      makeDetail({
        conversation: makeConversation({
          worktreePath: "/home/me/proj/.nas/worktree/foo",
        }),
      }),
      NOW_MS,
    );
    expect(view.directory).toBe("/home/me/proj");
    expect(view.directoryParent).toBe("/home/me/");
    expect(view.directoryBase).toBe("proj");
  });

  test("directory is empty when worktreePath is null", () => {
    const view = buildConversationHeader(
      makeDetail({
        conversation: makeConversation({ worktreePath: null }),
      }),
      NOW_MS,
    );
    expect(view.directory).toBe("");
    expect(view.directoryParent).toBe("");
    expect(view.directoryBase).toBe("");
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

describe("extractToolDetail", () => {
  test("Agent tool with description and subagent_type renders '<desc> (<type>)'", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({
        tool_name: "Task",
        subagent_type: "general-purpose",
        tool_input: JSON.stringify({
          description: "Echo test agent 1",
          prompt: "Run a quick echo and report",
        }),
      }),
    });
    expect(extractToolDetail(span)).toBe("Echo test agent 1 (general-purpose)");
  });

  test("Agent tool with only prompt (no description) returns the full prompt", () => {
    const longPrompt = "x".repeat(200);
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({
        tool_name: "Task",
        tool_input: JSON.stringify({ prompt: longPrompt }),
      }),
    });
    expect(extractToolDetail(span)).toBe(longPrompt);
  });

  test("Agent tool prefers description over prompt when both are present", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({
        tool_name: "Task",
        tool_input: JSON.stringify({
          description: "Short desc",
          prompt: "A much longer prompt that should be ignored",
        }),
      }),
    });
    expect(extractToolDetail(span)).toBe("Short desc");
  });

  test("Agent span with only top-level subagent_type returns the type", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({
        tool_name: "Agent",
        subagent_type: "Explore",
      }),
    });
    expect(extractToolDetail(span)).toBe("Explore");
  });

  test("Agent span with malformed tool_input falls back to subagent_type", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({
        tool_name: "Agent",
        subagent_type: "Explore",
        tool_input: "{not valid",
      }),
    });
    expect(extractToolDetail(span)).toBe("Explore");
  });

  test("Agent span with no relevant attrs returns null", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({ tool_name: "Agent" }),
    });
    expect(extractToolDetail(span)).toBeNull();
  });

  test("non-Agent execute_tool spans always return null", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: JSON.stringify({
        tool_name: "Bash",
        full_command: "echo hi",
      }),
    });
    expect(extractToolDetail(span)).toBeNull();
  });

  test("returns null for non-execute_tool spans", () => {
    const span = makeSpan({
      kind: "chat",
      attrsJson: JSON.stringify({
        tool_name: "Agent",
        subagent_type: "Explore",
      }),
    });
    expect(extractToolDetail(span)).toBeNull();
  });

  test("returns null when attrsJson is malformed (no throw)", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: "{not valid json",
    });
    expect(extractToolDetail(span)).toBeNull();
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

describe("buildSpanTreeByTurn", () => {
  test("DFS-flattens a 3-level tree and assigns depths 0/1/2 in pre-order", () => {
    const detail = makeDetail({
      traces: [
        makeTrace({
          traceId: "t1",
          startedAt: "2026-05-01T11:00:00.000Z",
          endedAt: "2026-05-01T11:00:02.500Z",
        }),
      ],
      spans: [
        makeSpan({
          spanId: "root",
          parentSpanId: null,
          traceId: "t1",
          spanName: "claude_code.interaction",
          kind: "chat",
          inTok: 100,
          outTok: 50,
          cacheR: 10,
          cacheW: 5,
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
        makeSpan({
          spanId: "mid",
          parentSpanId: "root",
          traceId: "t1",
          spanName: "claude_code.tool",
          kind: "execute_tool",
          inTok: 1,
          outTok: 2,
          cacheR: 3,
          cacheW: 4,
          startedAt: "2026-05-01T11:00:01.000Z",
        }),
        makeSpan({
          spanId: "leaf",
          parentSpanId: "mid",
          traceId: "t1",
          spanName: "claude_code.tool.execution",
          kind: "execute_tool",
          inTok: 7,
          outTok: 8,
          cacheR: 9,
          cacheW: 11,
          startedAt: "2026-05-01T11:00:02.000Z",
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group).toBeDefined();
    if (!group) return;
    const rows = group.rows;
    expect(rows.map((r) => r.spanId)).toEqual(["root", "mid", "leaf"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    // All eleven TurnSpanGroup fields surface on the same group.
    expect(group.traceId).toBe("t1");
    expect(group.traceIdLabel).toBe("t1");
    expect(group.turnIndex).toBe(1);
    expect(group.startedAtAbsolute).toBe("2026-05-01T11:00:00.000Z");
    expect(typeof group.startedAt).toBe("string");
    expect(group.durationLabel).toBe("2.5s");
    expect(group.spanCount).toBe(3);
    expect(group.llmCount).toBe(1);
    expect(group.toolCount).toBe(2);
    expect(group.inputTokens).toBe(108);
    expect(group.outputTokens).toBe(60);
    expect(group.cacheReadTokens).toBe(22);
    expect(group.cacheWriteTokens).toBe(20);
    expect(group.inputTokensCell).toBe("108");
    expect(group.outputTokensCell).toBe("60");
    expect(group.cacheReadTokensCell).toBe("22");
    expect(group.cacheWriteTokensCell).toBe("20");
  });

  test("aggregates chat / tool counts and token totals across mixed-kind spans", () => {
    const detail = makeDetail({
      traces: [
        makeTrace({
          traceId: "t1",
          startedAt: "2026-05-01T11:00:00.000Z",
          endedAt: "2026-05-01T11:00:01.000Z",
        }),
      ],
      spans: [
        makeSpan({
          spanId: "chat1",
          parentSpanId: null,
          traceId: "t1",
          kind: "chat",
          inTok: null,
          outTok: 50,
          cacheR: 10,
          cacheW: 5,
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
        makeSpan({
          spanId: "tool1",
          parentSpanId: "chat1",
          traceId: "t1",
          kind: "execute_tool",
          inTok: 100,
          outTok: 200,
          cacheR: 1,
          cacheW: 2,
          startedAt: "2026-05-01T11:00:00.500Z",
        }),
        makeSpan({
          spanId: "tool2",
          parentSpanId: "chat1",
          traceId: "t1",
          kind: "execute_tool",
          inTok: 23,
          outTok: 7,
          cacheR: 3,
          cacheW: 4,
          startedAt: "2026-05-01T11:00:00.700Z",
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group).toBeDefined();
    if (!group) return;
    expect(group.llmCount).toBe(1);
    expect(group.toolCount).toBe(2);
    // input: null + 100 + 23 → 123 (null contributes nothing).
    expect(group.inputTokens).toBe(123);
    expect(group.outputTokens).toBe(257);
    expect(group.cacheReadTokens).toBe(14);
    expect(group.cacheWriteTokens).toBe(11);
    expect(group.inputTokensCell).toBe("123");
    expect(group.outputTokensCell).toBe("257");
    expect(group.cacheReadTokensCell).toBe("14");
    expect(group.cacheWriteTokensCell).toBe("11");
  });

  test("token kind that is null on every span surfaces as null with hyphen-minus placeholder", () => {
    const detail = makeDetail({
      traces: [makeTrace({ traceId: "t1" })],
      spans: [
        makeSpan({
          spanId: "s1",
          traceId: "t1",
          inTok: null,
          outTok: 10,
          cacheR: null,
          cacheW: null,
        }),
        makeSpan({
          spanId: "s2",
          traceId: "t1",
          inTok: null,
          outTok: 20,
          cacheR: null,
          cacheW: null,
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    const group = groups[0];
    expect(group).toBeDefined();
    if (!group) return;
    expect(group.inputTokens).toBeNull();
    expect(group.outputTokens).toBe(30);
    expect(group.cacheReadTokens).toBeNull();
    expect(group.cacheWriteTokens).toBeNull();
    // Each null kind renders as the hyphen-minus placeholder so the
    // operator can tell "no data" apart from a true zero.
    expect(group.inputTokensCell).toBe("-");
    expect(group.outputTokensCell).toBe("30");
    expect(group.cacheReadTokensCell).toBe("-");
    expect(group.cacheWriteTokensCell).toBe("-");
  });

  test("open turn renders empty durationLabel while still summarising tokens", () => {
    const detail = makeDetail({
      traces: [makeTrace({ traceId: "t1", endedAt: null })],
      spans: [
        makeSpan({
          spanId: "s1",
          traceId: "t1",
          kind: "chat",
          inTok: 10,
          outTok: 20,
          cacheR: 0,
          cacheW: 0,
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    const group = groups[0];
    expect(group).toBeDefined();
    if (!group) return;
    expect(group.durationLabel).toBe("");
    expect(group.llmCount).toBe(1);
    expect(group.toolCount).toBe(0);
    expect(group.inputTokens).toBe(10);
    expect(group.outputTokens).toBe(20);
    expect(group.inputTokensCell).toBe("10");
    expect(group.outputTokensCell).toBe("20");
    expect(group.cacheReadTokensCell).toBe("0");
    expect(group.cacheWriteTokensCell).toBe("0");
  });

  test("siblings sharing a parent are sorted by startedAt ASC even when input is reversed", () => {
    const detail = makeDetail({
      traces: [makeTrace({ traceId: "t1" })],
      spans: [
        makeSpan({
          spanId: "root",
          parentSpanId: null,
          traceId: "t1",
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
        // Children supplied in reverse-time order.
        makeSpan({
          spanId: "later",
          parentSpanId: "root",
          traceId: "t1",
          startedAt: "2026-05-01T11:00:02.000Z",
        }),
        makeSpan({
          spanId: "earlier",
          parentSpanId: "root",
          traceId: "t1",
          startedAt: "2026-05-01T11:00:01.000Z",
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    const ids = (groups[0]?.rows ?? []).map((r) => r.spanId);
    expect(ids).toEqual(["root", "earlier", "later"]);
  });

  test("orphan spans (parent absent from same turn) surface as depth-0 roots", () => {
    const detail = makeDetail({
      traces: [makeTrace({ traceId: "t1" })],
      spans: [
        makeSpan({
          spanId: "orphan",
          parentSpanId: "missing_in_turn",
          traceId: "t1",
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    const rows = groups[0]?.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spanId).toBe("orphan");
    expect(rows[0]?.depth).toBe(0);
  });

  test("partitions spans across multiple traces; each group holds only its own", () => {
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
        makeSpan({
          spanId: "a1",
          parentSpanId: null,
          traceId: "trace_a",
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
        makeSpan({
          spanId: "a2",
          parentSpanId: "a1",
          traceId: "trace_a",
          startedAt: "2026-05-01T11:00:01.000Z",
        }),
        makeSpan({
          spanId: "b1",
          parentSpanId: null,
          traceId: "trace_b",
          startedAt: "2026-05-01T11:01:00.000Z",
        }),
        makeSpan({
          spanId: "b2",
          parentSpanId: "b1",
          traceId: "trace_b",
          startedAt: "2026-05-01T11:01:01.000Z",
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.traceId).toBe("trace_a");
    expect((groups[0]?.rows ?? []).map((r) => r.spanId)).toEqual(["a1", "a2"]);
    expect(groups[1]?.traceId).toBe("trace_b");
    expect((groups[1]?.rows ?? []).map((r) => r.spanId)).toEqual(["b1", "b2"]);
  });

  test("turnIndex starts at 1 in startedAt ASC order even when input is reversed", () => {
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
      spans: [
        // One non-zero-token span per trace so neither turn is dropped
        // by the zero-token filter.
        makeSpan({
          spanId: "early1",
          parentSpanId: null,
          traceId: "trace_early",
          startedAt: "2026-05-01T11:00:00.000Z",
          inTok: 1,
          outTok: 0,
          cacheR: 0,
          cacheW: 0,
        }),
        makeSpan({
          spanId: "late1",
          parentSpanId: null,
          traceId: "trace_late",
          startedAt: "2026-05-01T12:00:00.000Z",
          inTok: 1,
          outTok: 0,
          cacheR: 0,
          cacheW: 0,
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups[0]?.traceId).toBe("trace_early");
    expect(groups[0]?.turnIndex).toBe(1);
    expect(groups[0]?.startedAtAbsolute).toBe("2026-05-01T11:00:00.000Z");
    expect(groups[1]?.traceId).toBe("trace_late");
    expect(groups[1]?.turnIndex).toBe(2);
    expect(groups[1]?.startedAtAbsolute).toBe("2026-05-01T12:00:00.000Z");
  });

  test("returns an empty array when the conversation has no traces", () => {
    const detail = makeDetail({ traces: [], spans: [] });
    expect(buildSpanTreeByTurn(detail, NOW_MS)).toEqual([]);
  });

  test("durationLabel is the empty string for an open trace (endedAt = null)", () => {
    const detail = makeDetail({
      traces: [makeTrace({ endedAt: null })],
      spans: [makeSpan()],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups[0]?.durationLabel).toBe("");
  });

  test("durationLabel reflects formatDuration output for a closed trace", () => {
    const detail = makeDetail({
      traces: [
        makeTrace({
          startedAt: "2026-05-01T11:00:00.000Z",
          endedAt: "2026-05-01T11:01:00.000Z",
        }),
      ],
      spans: [makeSpan()],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups[0]?.durationLabel).toBe("1m");
  });

  test("durationLabel is the empty string when endedAt is unparseable", () => {
    const detail = makeDetail({
      traces: [makeTrace({ endedAt: "not-a-date" })],
      spans: [makeSpan()],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups[0]?.durationLabel).toBe("");
  });

  test("drops a turn whose four token totals are all null (no LLM data)", () => {
    const detail = makeDetail({
      traces: [makeTrace({ traceId: "t_aborted" })],
      spans: [
        makeSpan({
          spanId: "s1",
          parentSpanId: null,
          traceId: "t_aborted",
          inTok: null,
          outTok: null,
          cacheR: null,
          cacheW: null,
        }),
      ],
    });
    expect(buildSpanTreeByTurn(detail, NOW_MS)).toEqual([]);
  });

  test("drops a turn whose four token totals are all zero", () => {
    const detail = makeDetail({
      traces: [makeTrace({ traceId: "t_zero" })],
      spans: [
        makeSpan({
          spanId: "s1",
          parentSpanId: null,
          traceId: "t_zero",
          inTok: 0,
          outTok: 0,
          cacheR: 0,
          cacheW: 0,
        }),
      ],
    });
    expect(buildSpanTreeByTurn(detail, NOW_MS)).toEqual([]);
  });

  test("drops a turn with mixed null and zero token totals (still no work)", () => {
    const detail = makeDetail({
      traces: [makeTrace({ traceId: "t_mixed" })],
      spans: [
        makeSpan({
          spanId: "s1",
          parentSpanId: null,
          traceId: "t_mixed",
          inTok: null,
          outTok: 0,
          cacheR: null,
          cacheW: 0,
        }),
      ],
    });
    expect(buildSpanTreeByTurn(detail, NOW_MS)).toEqual([]);
  });

  test("retains a turn when at least one token total is positive", () => {
    const detail = makeDetail({
      traces: [makeTrace({ traceId: "t_kept" })],
      spans: [
        makeSpan({
          spanId: "s1",
          parentSpanId: null,
          traceId: "t_kept",
          inTok: 0,
          outTok: 0,
          cacheR: 0,
          cacheW: 1,
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.traceId).toBe("t_kept");
  });

  test("preserves turnIndex (allowing gaps) when a middle turn is dropped", () => {
    const detail = makeDetail({
      traces: [
        makeTrace({
          traceId: "t_first",
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
        makeTrace({
          traceId: "t_middle",
          startedAt: "2026-05-01T11:01:00.000Z",
        }),
        makeTrace({
          traceId: "t_third",
          startedAt: "2026-05-01T11:02:00.000Z",
        }),
      ],
      spans: [
        makeSpan({
          spanId: "first1",
          parentSpanId: null,
          traceId: "t_first",
          startedAt: "2026-05-01T11:00:00.000Z",
          inTok: 5,
          outTok: 0,
          cacheR: 0,
          cacheW: 0,
        }),
        // Middle turn has zero/null tokens across the board → dropped.
        makeSpan({
          spanId: "middle1",
          parentSpanId: null,
          traceId: "t_middle",
          startedAt: "2026-05-01T11:01:00.000Z",
          inTok: 0,
          outTok: null,
          cacheR: null,
          cacheW: 0,
        }),
        makeSpan({
          spanId: "third1",
          parentSpanId: null,
          traceId: "t_third",
          startedAt: "2026-05-01T11:02:00.000Z",
          inTok: 0,
          outTok: 7,
          cacheR: 0,
          cacheW: 0,
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.traceId).toBe("t_first");
    expect(groups[0]?.turnIndex).toBe(1);
    expect(groups[1]?.traceId).toBe("t_third");
    // Middle turn is hidden, so the third turn keeps its original index 3.
    expect(groups[1]?.turnIndex).toBe(3);
  });
});

describe("summariseTraceSpansByModel", () => {
  test("collapses multiple spans on the same model into a single row", () => {
    const rows = summariseTraceSpansByModel([
      makeSpan({
        spanId: "s1",
        model: "claude-3-5-sonnet",
        inTok: 100,
        outTok: 50,
        cacheR: 10,
        cacheW: 5,
      }),
      makeSpan({
        spanId: "s2",
        model: "claude-3-5-sonnet",
        inTok: 200,
        outTok: 60,
        cacheR: null,
        cacheW: 0,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe("claude-3-5-sonnet");
    expect(rows[0]?.inputTokens).toBe(300);
    expect(rows[0]?.outputTokens).toBe(110);
    // null token contributes 0 — no NaN, no ripple onto the rest.
    expect(rows[0]?.cacheRead).toBe(10);
    expect(rows[0]?.cacheWrite).toBe(5);
  });

  test("model=null spans collapse to a dedicated row sorted last", () => {
    const rows = summariseTraceSpansByModel([
      makeSpan({
        spanId: "s_null",
        model: null,
        inTok: 7,
        outTok: 3,
        cacheR: 0,
        cacheW: 0,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBeNull();
    expect(rows[0]?.inputTokens).toBe(7);
    expect(rows[0]?.outputTokens).toBe(3);
  });

  test("multiple models produce one row each in deterministic order (model ASC, null last)", () => {
    const rows = summariseTraceSpansByModel([
      makeSpan({ spanId: "s_z", model: "z-model", inTok: 1 }),
      makeSpan({ spanId: "s_null", model: null, inTok: 2 }),
      makeSpan({ spanId: "s_a", model: "a-model", inTok: 3 }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.model).toBe("a-model");
    expect(rows[1]?.model).toBe("z-model");
    expect(rows[2]?.model).toBeNull();
  });

  test("buckets a span into above-200k when its effective input crosses the threshold", () => {
    const rows = summariseTraceSpansByModel([
      // Below: 100k + 50k + 30k = 180k.
      makeSpan({
        spanId: "below",
        model: "claude-opus",
        inTok: 100_000,
        outTok: 5_000,
        cacheR: 50_000,
        cacheW: 30_000,
      }),
      // Above: 150k + 60k + 0 = 210k.
      makeSpan({
        spanId: "above",
        model: "claude-opus",
        inTok: 150_000,
        outTok: 7_000,
        cacheR: 60_000,
        cacheW: 0,
      }),
    ]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.inputTokens).toBe(250_000);
    expect(r?.outputTokens).toBe(12_000);
    expect(r?.cacheRead).toBe(110_000);
    expect(r?.cacheWrite).toBe(30_000);
    // Only the "above" span contributes to the 200k bucket.
    expect(r?.inputTokensAbove200k).toBe(150_000);
    expect(r?.outputTokensAbove200k).toBe(7_000);
    expect(r?.cacheReadAbove200k).toBe(60_000);
    expect(r?.cacheWriteAbove200k).toBe(0);
  });

  test("buildSpanTreeByTurn attaches perModelTotals per turn", () => {
    const detail = makeDetail({
      traces: [
        makeTrace({
          traceId: "t_a",
          startedAt: "2026-05-01T11:00:00.000Z",
          endedAt: "2026-05-01T11:00:30.000Z",
        }),
        makeTrace({
          traceId: "t_b",
          startedAt: "2026-05-01T11:01:00.000Z",
          endedAt: "2026-05-01T11:01:30.000Z",
        }),
      ],
      spans: [
        makeSpan({
          spanId: "a1",
          parentSpanId: null,
          traceId: "t_a",
          model: "modelA",
          inTok: 10,
          outTok: 5,
          startedAt: "2026-05-01T11:00:00.000Z",
        }),
        makeSpan({
          spanId: "a2",
          parentSpanId: null,
          traceId: "t_a",
          model: "modelA",
          inTok: 20,
          outTok: 10,
          startedAt: "2026-05-01T11:00:10.000Z",
        }),
        makeSpan({
          spanId: "b1",
          parentSpanId: null,
          traceId: "t_b",
          model: "modelB",
          inTok: 1,
          outTok: 2,
          startedAt: "2026-05-01T11:01:00.000Z",
        }),
      ],
    });
    const groups = buildSpanTreeByTurn(detail, NOW_MS);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.perModelTotals).toEqual([
      {
        model: "modelA",
        inputTokens: 30,
        outputTokens: 15,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokensAbove200k: 0,
        outputTokensAbove200k: 0,
        cacheReadAbove200k: 0,
        cacheWriteAbove200k: 0,
      },
    ]);
    expect(groups[1]?.perModelTotals).toEqual([
      {
        model: "modelB",
        inputTokens: 1,
        outputTokens: 2,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokensAbove200k: 0,
        outputTokensAbove200k: 0,
        cacheReadAbove200k: 0,
        cacheWriteAbove200k: 0,
      },
    ]);
  });
});
