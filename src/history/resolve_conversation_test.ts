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

test("same span has both: gen_ai.conversation.id wins", () => {
  expect(
    pickConversationIdFromSpans([
      {
        attributes: {
          "gen_ai.conversation.id": "conv_x",
          "session.id": "conv_y",
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
