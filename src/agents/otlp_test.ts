import { expect, test } from "bun:test";
import {
  analyzeTraceUsageSources,
  classifySpan,
  pickConversationIdFromSpans,
  resolveSpanUsageColumns,
} from "./otlp.ts";

test("layer 1: gen_ai.operation.name=chat overrides any name", () => {
  expect(
    classifySpan("completely_unrelated", { "gen_ai.operation.name": "chat" }),
  ).toEqual("chat");
});

test("layer 1: gen_ai.operation.name=execute_tool wins over name='claude_code.tool'", () => {
  expect(
    classifySpan("claude_code.tool", {
      "gen_ai.operation.name": "execute_tool",
    }),
  ).toEqual("execute_tool");
});

test("layer 1: gen_ai.operation.name=invoke_agent", () => {
  expect(
    classifySpan("anything", { "gen_ai.operation.name": "invoke_agent" }),
  ).toEqual("invoke_agent");
});

test("layer 1 priority: gen_ai.operation.name=chat overrides claude_code.tool which would be execute_tool at layer 3", () => {
  expect(
    classifySpan("claude_code.tool", { "gen_ai.operation.name": "chat" }),
  ).toEqual("chat");
});

test("layer 2: name='execute_tool' exact match", () => {
  expect(classifySpan("execute_tool", {})).toEqual("execute_tool");
});

test("layer 2: name='chat' exact match", () => {
  expect(classifySpan("chat", {})).toEqual("chat");
});

test("layer 2: name='invoke_agent' exact match", () => {
  expect(classifySpan("invoke_agent", {})).toEqual("invoke_agent");
});

test("layer 2 chat variant: name='gen_ai.client.operation' exact", () => {
  expect(classifySpan("gen_ai.client.operation", {})).toEqual("chat");
});

test("layer 2 chat variant: name='gen_ai.client.operation.completion'", () => {
  expect(classifySpan("gen_ai.client.operation.completion", {})).toEqual(
    "chat",
  );
});

test("layer 3: name='claude_code.llm_request' -> chat", () => {
  expect(classifySpan("claude_code.llm_request", {})).toEqual("chat");
});

test("layer 3: name='claude_code.tool' -> execute_tool", () => {
  expect(classifySpan("claude_code.tool", {})).toEqual("execute_tool");
});

test("layer 3: name='claude_code.tool.bash' -> execute_tool", () => {
  expect(classifySpan("claude_code.tool.bash", {})).toEqual("execute_tool");
});

test("layer 4: Codex session_task.turn -> invoke_agent", () => {
  expect(classifySpan("session_task.turn", {})).toEqual("invoke_agent");
});

test("layer 4: Codex session_task.user_shell -> execute_tool", () => {
  expect(classifySpan("session_task.user_shell", {})).toEqual("execute_tool");
});

test("layer 4: Codex mcp.tools.call -> execute_tool", () => {
  expect(classifySpan("mcp.tools.call", {})).toEqual("execute_tool");
});

test("layer 4: Codex token usage span -> chat", () => {
  expect(classifySpan("codex.turn.token_usage", {})).toEqual("chat");
});

test.each([
  "codex.response",
  "codex.responses",
  "model_client.stream_responses",
  "model_client.stream_responses_websocket",
  "responses.stream_request",
  "responses_websocket.stream_request",
])("layer 4: Codex response/stream span %s -> chat", (name) => {
  expect(classifySpan(name, {})).toEqual("chat");
});

test("layer 5: name='chat gpt-4' -> chat", () => {
  expect(classifySpan("chat gpt-4", {})).toEqual("chat");
});

test("layer 5: name='execute_tool shell' -> execute_tool", () => {
  expect(classifySpan("execute_tool shell", {})).toEqual("execute_tool");
});

test("layer 5: name='invoke_agent agent_default' -> invoke_agent", () => {
  expect(classifySpan("invoke_agent agent_default", {})).toEqual(
    "invoke_agent",
  );
});

test("layer 6: gen_ai.system attribute -> chat", () => {
  expect(
    classifySpan("something_random", { "gen_ai.system": "anthropic" }),
  ).toEqual("chat");
});

test("layer 7: nothing matches -> other", () => {
  expect(classifySpan("something_random", {})).toEqual("other");
});

test("layer 1 ignores invalid op values and falls through", () => {
  // unrecognised op value isn't one of {chat, execute_tool, invoke_agent}, so
  // layer 1 doesn't claim the span; the canonical name still matches at layer 2.
  expect(classifySpan("chat", { "gen_ai.operation.name": "bogus" })).toEqual(
    "chat",
  );
});

test("single span with gen_ai.conversation.id", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: { "gen_ai.conversation.id": "conv_x" } },
    ]),
  ).toEqual("conv_x");
});

test("single span with session.id only", () => {
  expect(
    pickConversationIdFromSpans([{ attributes: { "session.id": "conv_y" } }]),
  ).toEqual("conv_y");
});

test("single span with Codex conversation.id only", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: { "conversation.id": "conv_codex" } },
    ]),
  ).toEqual("conv_codex");
});

test("single span with Codex thread.id only", () => {
  expect(
    pickConversationIdFromSpans([{ attributes: { "thread.id": "thread_x" } }]),
  ).toEqual("thread_x");
});

test("same span has both: gen_ai.conversation.id wins", () => {
  expect(
    pickConversationIdFromSpans([
      {
        attributes: {
          "gen_ai.conversation.id": "conv_x",
          "session.id": "conv_y",
          "conversation.id": "conv_codex",
          "thread.id": "thread_x",
        },
      },
    ]),
  ).toEqual("conv_x");
});

test("empty gen_ai.conversation.id falls back to session.id on the same span", () => {
  expect(
    pickConversationIdFromSpans([
      {
        attributes: {
          "gen_ai.conversation.id": "",
          "session.id": "conv_y",
        },
      },
    ]),
  ).toEqual("conv_y");
});

test("empty gen_ai.conversation.id and session.id fall back to Codex conversation.id", () => {
  expect(
    pickConversationIdFromSpans([
      {
        attributes: {
          "gen_ai.conversation.id": "",
          "session.id": "",
          "conversation.id": "conv_codex",
          "thread.id": "thread_x",
        },
      },
    ]),
  ).toEqual("conv_codex");
});

test("empty conversation.id falls back to Codex thread.id", () => {
  expect(
    pickConversationIdFromSpans([
      {
        attributes: {
          "conversation.id": "",
          "thread.id": "thread_x",
        },
      },
    ]),
  ).toEqual("thread_x");
});

test("Codex shell_snapshot thread_id (underscore) is picked up", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: { thread_id: "thread_underscore" } },
    ]),
  ).toEqual("thread_underscore");
});

test("thread.id (UUID string) wins over thread_id when both present", () => {
  expect(
    pickConversationIdFromSpans([
      {
        attributes: {
          "thread.id": "uuid_dot",
          thread_id: "uuid_underscore",
        },
      },
    ]),
  ).toEqual("uuid_dot");
});

test("OS thread.id as integer is ignored, thread_id string is taken", () => {
  expect(
    pickConversationIdFromSpans([
      {
        attributes: {
          "thread.id": 21,
          thread_id: "uuid_underscore",
        },
      },
    ]),
  ).toEqual("uuid_underscore");
});

test("later gen_ai.conversation.id wins over earlier Codex conversation.id", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: { "conversation.id": "conv_codex_early" } },
      { attributes: { "gen_ai.conversation.id": "conv_gen_ai_late" } },
    ]),
  ).toEqual("conv_gen_ai_late");
});

test("later session.id wins over earlier Codex conversation.id", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: { "conversation.id": "conv_codex_early" } },
      { attributes: { "session.id": "conv_session_late" } },
    ]),
  ).toEqual("conv_session_late");
});

test("scans in input order: skips empty spans then picks the first carrier", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: {} },
      { attributes: {} },
      { attributes: { "session.id": "conv_late" } },
    ]),
  ).toEqual("conv_late");
});

test("no span carries an id -> null", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: {} },
      { attributes: { "irrelevant.key": "x" } },
    ]),
  ).toBeNull();
});

test("empty array -> null", () => {
  expect(pickConversationIdFromSpans([])).toBeNull();
});

test("attributes undefined on a span is treated as empty", () => {
  expect(
    pickConversationIdFromSpans([
      {},
      { attributes: { "gen_ai.conversation.id": "conv_z" } },
    ]),
  ).toEqual("conv_z");
});

test("first span with non-empty gen_ai wins over later session.id", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: { "gen_ai.conversation.id": "conv_first" } },
      { attributes: { "session.id": "conv_second" } },
    ]),
  ).toEqual("conv_first");
});

test("usage sources detect codex token_usage and response spans with finite token attrs", () => {
  expect(
    analyzeTraceUsageSources([
      {
        name: "codex.turn.token_usage",
        attributes: { "gen_ai.usage.input_tokens": 10 },
      },
      {
        name: "responses.stream_request",
        attributes: { "gen_ai.usage.output_tokens": 20 },
      },
    ]),
  ).toEqual({
    hasCodexTokenUsage: true,
    hasCodexResponseOrStreamWithUsage: true,
  });
});

test("usage sources ignore response spans without finite token attrs", () => {
  expect(
    analyzeTraceUsageSources([
      {
        name: "model_client.stream_responses_websocket",
        attributes: { model: "gpt-5.4-mini" },
      },
      {
        name: "responses.stream_request",
        attributes: { "gen_ai.usage.input_tokens": "42" },
      },
    ]),
  ).toEqual({
    hasCodexTokenUsage: false,
    hasCodexResponseOrStreamWithUsage: false,
  });
});

test("usage columns prefer semantic model and token keys over flat and Codex fallback keys", () => {
  expect(
    resolveSpanUsageColumns({
      kind: "chat",
      spanName: "chat",
      traceUsageSources: {
        hasCodexTokenUsage: false,
        hasCodexResponseOrStreamWithUsage: false,
      },
      attrs: {
        "gen_ai.response.model": "gpt-response",
        "gen_ai.request.model": "gpt-request",
        model: "gpt-flat",
        "gen_ai.usage.input_tokens": 101,
        input_tokens: 202,
        "codex.turn.token_usage.input_tokens": 303,
        "gen_ai.usage.output_tokens": 11,
        output_tokens: 22,
        "gen_ai.usage.cache_read.input_tokens": 7,
        "gen_ai.usage.cache_read_input_tokens": 8,
        cache_read_tokens: 9,
        "gen_ai.usage.cache_creation.input_tokens": 3,
        "gen_ai.usage.cache_creation_input_tokens": 4,
        cache_creation_tokens: 5,
      },
    }),
  ).toEqual({
    model: "gpt-response",
    inTok: 101,
    outTok: 11,
    cacheR: 7,
    cacheW: 3,
  });
});

test("usage columns do not promote non-chat spans except session_task.turn fallback", () => {
  expect(
    resolveSpanUsageColumns({
      kind: "execute_tool",
      spanName: "execute_tool",
      traceUsageSources: {
        hasCodexTokenUsage: false,
        hasCodexResponseOrStreamWithUsage: false,
      },
      attrs: {
        model: "gpt-tool",
        input_tokens: 99,
      },
    }),
  ).toEqual({
    model: null,
    inTok: null,
    outTok: null,
    cacheR: null,
    cacheW: null,
  });
});

test("codex token_usage span suppresses response stream usage columns to avoid double counting", () => {
  expect(
    resolveSpanUsageColumns({
      kind: "chat",
      spanName: "model_client.stream_responses_websocket",
      traceUsageSources: {
        hasCodexTokenUsage: true,
        hasCodexResponseOrStreamWithUsage: true,
      },
      attrs: {
        model: "gpt-stream",
        input_tokens: 42,
        output_tokens: 24,
      },
    }),
  ).toEqual({
    model: null,
    inTok: null,
    outTok: null,
    cacheR: null,
    cacheW: null,
  });
});

test("codex response stream promotes usage when token_usage span is absent", () => {
  expect(
    resolveSpanUsageColumns({
      kind: "chat",
      spanName: "responses.stream_request",
      traceUsageSources: {
        hasCodexTokenUsage: false,
        hasCodexResponseOrStreamWithUsage: true,
      },
      attrs: {
        "gen_ai.request.model": "gpt-response",
        "gen_ai.usage.input_tokens": 77,
        "gen_ai.usage.output_tokens": 33,
        "gen_ai.usage.cache_read_input_tokens": 11,
        "gen_ai.usage.cache_creation_input_tokens": 5,
      },
    }),
  ).toEqual({
    model: "gpt-response",
    inTok: 77,
    outTok: 33,
    cacheR: 11,
    cacheW: 5,
  });
});

test("session_task.turn fallback promotes Codex usage when no higher-priority source exists", () => {
  expect(
    resolveSpanUsageColumns({
      kind: "invoke_agent",
      spanName: "session_task.turn",
      traceUsageSources: {
        hasCodexTokenUsage: false,
        hasCodexResponseOrStreamWithUsage: false,
      },
      attrs: {
        model: "gpt-5.4-mini",
        "codex.turn.token_usage.input_tokens": 11496,
        "codex.turn.token_usage.output_tokens": 144,
        "codex.turn.token_usage.cache_read_input_tokens": 6528,
        "codex.turn.token_usage.cache_creation.input_tokens": 6,
      },
    }),
  ).toEqual({
    model: "gpt-5.4-mini",
    inTok: 11496,
    outTok: 144,
    cacheR: 6528,
    cacheW: 6,
  });
});

test("session_task.turn fallback is suppressed when response stream has token usage", () => {
  expect(
    resolveSpanUsageColumns({
      kind: "invoke_agent",
      spanName: "session_task.turn",
      traceUsageSources: {
        hasCodexTokenUsage: false,
        hasCodexResponseOrStreamWithUsage: true,
      },
      attrs: {
        model: "gpt-turn",
        "codex.turn.token_usage.input_tokens": 88,
      },
    }),
  ).toEqual({
    model: null,
    inTok: null,
    outTok: null,
    cacheR: null,
    cacheW: null,
  });
});
