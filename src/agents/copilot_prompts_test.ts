import { describe, expect, test } from "bun:test";
import type { SpanSummaryRow } from "../history/types";
import { extractCopilotTracePrompts } from "./copilot_prompts";

// A root `invoke_agent` span carrying the OTEL GenAI semconv
// `gen_ai.input.messages` attribute (a JSON-stringified array of messages
// shaped `{role, parts:[{type:"text",content}]}`).
function makeCopilotInvokeAgent(
  traceId: string,
  messages: ReadonlyArray<{
    role: string;
    parts: ReadonlyArray<{ type: string; content?: string }>;
  }>,
  overrides: Partial<SpanSummaryRow> = {},
): SpanSummaryRow {
  return {
    spanId: `inv_${traceId}`,
    parentSpanId: null,
    traceId,
    spanName: "invoke_agent",
    kind: "invoke_agent",
    model: null,
    inTok: 10,
    outTok: 5,
    cacheR: 0,
    cacheW: 0,
    durationMs: 100,
    startedAt: "2026-05-01T11:00:00.000Z",
    endedAt: "2026-05-01T11:00:05.000Z",
    attrsJson: JSON.stringify({
      "gen_ai.input.messages": JSON.stringify(messages),
    }),
    eventsJson: null,
    ...overrides,
  };
}

describe("extractCopilotTracePrompts", () => {
  test("resolves traceId → prompt from a root invoke_agent's input.messages", () => {
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [
        { role: "user", parts: [{ type: "text", content: "Hello copilot" }] },
      ]),
    ]);
    expect(result.get("t1")).toBe("Hello copilot");
  });

  test("concatenates multiple text parts in a single user message", () => {
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [
        {
          role: "user",
          parts: [
            { type: "text", content: "part-one " },
            { type: "text", content: "part-two" },
          ],
        },
      ]),
    ]);
    expect(result.get("t1")).toBe("part-one part-two");
  });

  test("skips `<system_notification>` user messages so they don't shadow the real prompt", () => {
    // Copilot injects a synthetic user-role `<system_notification>…` block
    // after a subagent finishes. The real user prompt should win.
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [
        { role: "user", parts: [{ type: "text", content: "the real prompt" }] },
        {
          role: "user",
          parts: [
            {
              type: "text",
              content:
                "<system_notification>Agent finished</system_notification>",
            },
          ],
        },
      ]),
    ]);
    expect(result.get("t1")).toBe("the real prompt");
  });

  test("last non-notification user message wins across multiple user turns in one span", () => {
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [
        { role: "user", parts: [{ type: "text", content: "older prompt" }] },
        { role: "assistant", parts: [{ type: "text", content: "ack" }] },
        { role: "user", parts: [{ type: "text", content: "newest prompt" }] },
      ]),
    ]);
    expect(result.get("t1")).toBe("newest prompt");
  });

  test("ignores subagent invoke_agent spans (parentSpanId !== null)", () => {
    // A nested `invoke_agent <name>` is a subagent handoff, not a user-typed
    // prompt — it must not surface as the parent trace's prompt.
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [
        { role: "user", parts: [{ type: "text", content: "outer prompt" }] },
      ]),
      makeCopilotInvokeAgent(
        "t1",
        [
          {
            role: "user",
            parts: [{ type: "text", content: "subagent handoff" }],
          },
        ],
        {
          spanId: "sub_inv",
          parentSpanId: "inv_t1",
          spanName: "invoke_agent explore",
        },
      ),
    ]);
    expect(result.get("t1")).toBe("outer prompt");
  });

  test("no entry when input.messages is absent on the invoke_agent span", () => {
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [], { attrsJson: "{}" }),
    ]);
    expect(result.has("t1")).toBe(false);
  });

  test("no entry when attrs_json is malformed", () => {
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [], { attrsJson: "not-json" }),
    ]);
    expect(result.has("t1")).toBe(false);
  });

  test("no entry when input.messages parses to a non-array", () => {
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [], {
        attrsJson: JSON.stringify({
          "gen_ai.input.messages": JSON.stringify({ not: "an array" }),
        }),
      }),
    ]);
    expect(result.has("t1")).toBe(false);
  });

  test("no entry when every user message is a system_notification", () => {
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t1", [
        {
          role: "user",
          parts: [
            {
              type: "text",
              content:
                "<system_notification>Agent x finished</system_notification>",
            },
          ],
        },
      ]),
    ]);
    expect(result.has("t1")).toBe(false);
  });

  test("multiple traces get isolated prompts", () => {
    const result = extractCopilotTracePrompts([
      makeCopilotInvokeAgent("t_a", [
        { role: "user", parts: [{ type: "text", content: "alpha" }] },
      ]),
      makeCopilotInvokeAgent("t_b", [
        { role: "user", parts: [{ type: "text", content: "beta" }] },
      ]),
    ]);
    expect(result.get("t_a")).toBe("alpha");
    expect(result.get("t_b")).toBe("beta");
  });
});
