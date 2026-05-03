import { describe, expect, test } from "bun:test";
import {
  bareAgentLabel,
  classifyAgent,
  extractToolDetail,
  extractToolName,
  type ToolDisplaySpan,
} from "./display";

function makeSpan(overrides: Partial<ToolDisplaySpan> = {}): ToolDisplaySpan {
  return {
    spanName: "chat.completion",
    kind: "client",
    attrsJson: "{}",
    ...overrides,
  };
}

describe("classifyAgent", () => {
  test("returns an empty class for null and unknown agents", () => {
    expect(classifyAgent(null)).toBe("");
    expect(classifyAgent("other-agent")).toBe("");
  });

  test("maps known agents to stable CSS variants", () => {
    expect(classifyAgent("claude-code")).toBe("is-claude");
    expect(classifyAgent("github-copilot")).toBe("is-copilot");
    expect(classifyAgent("openai-codex")).toBe("is-codex");
  });
});

describe("bareAgentLabel", () => {
  test("returns an empty label for null", () => {
    expect(bareAgentLabel(null)).toBe("");
  });

  test("normalizes known agents to bare labels", () => {
    expect(bareAgentLabel("claude-code")).toBe("claude");
    expect(bareAgentLabel("github-copilot")).toBe("copilot");
    expect(bareAgentLabel("openai-codex")).toBe("codex");
  });

  test("returns unknown agent labels unchanged", () => {
    expect(bareAgentLabel("custom-agent")).toBe("custom-agent");
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

  test("falls back to `execute_tool <name>` span-name regex", () => {
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

  test("returns null when attrsJson is malformed", () => {
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

  test("non-object attrs fall through to span-name regex", () => {
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

  test("Agent tool with only prompt returns the full prompt", () => {
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

  test("returns null when attrsJson is malformed", () => {
    const span = makeSpan({
      kind: "execute_tool",
      attrsJson: "{not valid json",
    });
    expect(extractToolDetail(span)).toBeNull();
  });
});
