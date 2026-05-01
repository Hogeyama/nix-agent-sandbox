import { expect, test } from "bun:test";
import { classifySpan } from "./classify.ts";

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

test("layer 3: name='claude_code.llm_request' → chat", () => {
  expect(classifySpan("claude_code.llm_request", {})).toEqual("chat");
});

test("layer 3: name='claude_code.tool' → execute_tool", () => {
  expect(classifySpan("claude_code.tool", {})).toEqual("execute_tool");
});

test("layer 3: name='claude_code.tool.bash' → execute_tool", () => {
  expect(classifySpan("claude_code.tool.bash", {})).toEqual("execute_tool");
});

test("layer 4: name='chat gpt-4' → chat", () => {
  expect(classifySpan("chat gpt-4", {})).toEqual("chat");
});

test("layer 4: name='execute_tool shell' → execute_tool", () => {
  expect(classifySpan("execute_tool shell", {})).toEqual("execute_tool");
});

test("layer 4: name='invoke_agent agent_default' → invoke_agent", () => {
  expect(classifySpan("invoke_agent agent_default", {})).toEqual(
    "invoke_agent",
  );
});

test("layer 5: gen_ai.system attribute → chat", () => {
  expect(
    classifySpan("something_random", { "gen_ai.system": "anthropic" }),
  ).toEqual("chat");
});

test("layer 6: nothing matches → other", () => {
  expect(classifySpan("something_random", {})).toEqual("other");
});

test("layer 1 ignores invalid op values and falls through", () => {
  // unrecognised op value isn't one of {chat, execute_tool, invoke_agent}, so
  // layer 1 doesn't claim the span; the canonical name still matches at layer 2.
  expect(classifySpan("chat", { "gen_ai.operation.name": "bogus" })).toEqual(
    "chat",
  );
});
