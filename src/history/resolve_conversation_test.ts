import { expect, test } from "bun:test";
import { pickConversationIdFromSpans } from "./resolve_conversation.ts";

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

test("no span carries an id → null", () => {
  expect(
    pickConversationIdFromSpans([
      { attributes: {} },
      { attributes: { "irrelevant.key": "x" } },
    ]),
  ).toBeNull();
});

test("empty array → null", () => {
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
