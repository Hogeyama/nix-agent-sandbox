import { describe, expect, test } from "bun:test";
import type {
  ConversationListRow,
  InvocationDetail,
  InvocationSummaryRow,
  InvocationTurnEventRow,
} from "../../../../../history/types";
import {
  buildConversationLinks,
  buildInvocationHeader,
  buildInvocationTurnEventRows,
} from "./invocationDetailView";

const NOW_MS = Date.parse("2026-05-01T12:00:00.000Z");

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

function makeConversation(
  overrides: Partial<ConversationListRow> = {},
): ConversationListRow {
  return {
    id: "sess_aabbccdd11223344",
    agent: "claude-code",
    firstSeenAt: "2026-04-30T12:00:00.000Z",
    lastSeenAt: "2026-05-01T08:00:00.000Z",
    turnEventCount: 4,
    spanCount: 6,
    invocationCount: 1,
    inputTokensTotal: 200,
    outputTokensTotal: 100,
    cacheReadTotal: 0,
    cacheWriteTotal: 0,
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<InvocationDetail> = {},
): InvocationDetail {
  return {
    invocation: makeInvocation(),
    traces: [],
    spans: [],
    turnEvents: [],
    conversations: [makeConversation()],
    ...overrides,
  };
}

describe("buildInvocationHeader", () => {
  test("projects every header field and aggregates counts from arrays", () => {
    const view = buildInvocationHeader(
      makeDetail({
        traces: [
          {
            traceId: "t1",
            invocationId: "inv_xxxxxxxxxxxxxxxx",
            conversationId: "sess_aabbccdd11223344",
            startedAt: "2026-05-01T11:05:00.000Z",
            endedAt: "2026-05-01T11:10:00.000Z",
            spanCount: 3,
          },
        ],
        spans: [],
        turnEvents: [
          {
            conversationId: "sess_aabbccdd11223344",
            ts: "2026-05-01T11:08:00.000Z",
            kind: "user_message",
            payloadJson: "{}",
          },
          {
            conversationId: "sess_aabbccdd11223344",
            ts: "2026-05-01T11:09:00.000Z",
            kind: "assistant_message",
            payloadJson: "{}",
          },
        ],
        conversations: [
          makeConversation({ inputTokensTotal: 200, outputTokensTotal: 100 }),
          makeConversation({
            id: "sess_zzzz",
            inputTokensTotal: 50,
            outputTokensTotal: 25,
          }),
        ],
      }),
      NOW_MS,
    );
    expect(view.id).toBe("inv_xxxxxxxxxxxxxxxx");
    expect(view.idLabel).toBe("inv_xxxx");
    expect(view.profile).toBe("default");
    expect(view.agent).toBe("claude-code");
    expect(view.worktreePath).toBe("/work/repo");
    expect(view.startedAt).toBe("1h ago");
    expect(view.endedAt).not.toBe("(running)");
    expect(view.exitReason).toBe("completed");
    expect(view.turnCount).toBe(2);
    expect(view.traceCount).toBe(1);
    expect(view.spanCount).toBe(0);
    expect(view.conversationCount).toBe(2);
    // 200 + 100 + 50 + 25
    expect(view.tokenTotal).toBe(375);
  });

  test("renders nullable invocation fields with their placeholders", () => {
    const view = buildInvocationHeader(
      makeDetail({
        invocation: makeInvocation({
          profile: null,
          agent: null,
          worktreePath: null,
          endedAt: null,
          exitReason: null,
        }),
      }),
      NOW_MS,
    );
    expect(view.profile).toBe("(none)");
    expect(view.agent).toBe("(unknown)");
    expect(view.worktreePath).toBe("(unknown)");
    expect(view.endedAt).toBe("(running)");
    expect(view.exitReason).toBe("(unknown)");
  });
});

describe("buildConversationLinks", () => {
  test("returns one row per conversation (subagent case)", () => {
    const view = buildConversationLinks(
      makeDetail({
        conversations: [
          makeConversation({ id: "sess_parent_xxxxxxxx" }),
          makeConversation({
            id: "sess_subagent_yyyyyyyy",
            agent: null,
            inputTokensTotal: 7,
            outputTokensTotal: 3,
          }),
        ],
      }),
    );
    expect(view).toHaveLength(2);
    expect(view[0]?.idLabel).toBe("sess_par");
    expect(view[0]?.href).toBe("#/history/conversation/sess_parent_xxxxxxxx");
    expect(view[1]?.idLabel).toBe("sess_sub");
    expect(view[1]?.agent).toBe("(unknown)");
    expect(view[1]?.tokenTotal).toBe(10);
  });

  test("returns empty when no conversations are linked", () => {
    expect(buildConversationLinks(makeDetail({ conversations: [] }))).toEqual(
      [],
    );
  });

  test("encodes hash-unsafe ids", () => {
    const view = buildConversationLinks(
      makeDetail({
        conversations: [makeConversation({ id: "sess with space" })],
      }),
    );
    expect(view[0]?.href).toBe("#/history/conversation/sess%20with%20space");
  });
});

describe("buildInvocationTurnEventRows", () => {
  function makeEvent(
    overrides: Partial<InvocationTurnEventRow> = {},
  ): InvocationTurnEventRow {
    return {
      conversationId: "sess_aabbccdd11223344",
      ts: "2026-05-01T11:30:00.000Z",
      kind: "user_message",
      payloadJson: `{"text":"hi"}`,
      ...overrides,
    };
  }

  test("links the event row at the conversation, not the invocation", () => {
    const view = buildInvocationTurnEventRows([makeEvent()], NOW_MS);
    expect(view[0]?.linkHref).toBe(
      "#/history/conversation/sess_aabbccdd11223344",
    );
    expect(view[0]?.linkIdLabel).toBe("sess_aab");
  });

  test("renders a null conversation id with the dash placeholder and no href", () => {
    const view = buildInvocationTurnEventRows(
      [makeEvent({ conversationId: null })],
      NOW_MS,
    );
    expect(view[0]?.linkIdLabel).toBe("—");
    expect(view[0]?.linkHref).toBe("");
  });

  test("returns empty for no events", () => {
    expect(buildInvocationTurnEventRows([], NOW_MS)).toEqual([]);
  });
});
