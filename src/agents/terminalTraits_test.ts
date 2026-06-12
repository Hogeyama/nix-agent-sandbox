import { describe, expect, test } from "bun:test";
import { getAgentTerminalTraits } from "./terminalTraits";

describe("getAgentTerminalTraits", () => {
  test("enables autoForceMouseMode for the bare 'copilot' identifier", () => {
    expect(getAgentTerminalTraits("copilot").autoForceMouseMode).toBe(true);
  });

  test("enables autoForceMouseMode for vendor-prefixed copilot identifiers", () => {
    expect(getAgentTerminalTraits("github-copilot").autoForceMouseMode).toBe(
      true,
    );
  });

  test("matches copilot case-insensitively", () => {
    expect(getAgentTerminalTraits("Copilot").autoForceMouseMode).toBe(true);
  });

  test("enables autoForceMouseMode for claude", () => {
    // Claude Code emits its mouse-tracking DECSET only at startup; dtach
    // does not replay terminal modes on re-attach, so the UI terminal must
    // force mouse mode itself.
    expect(getAgentTerminalTraits("claude").autoForceMouseMode).toBe(true);
  });

  test("matches claude case-insensitively", () => {
    expect(getAgentTerminalTraits("Claude").autoForceMouseMode).toBe(true);
  });

  test("leaves autoForceMouseMode off for codex", () => {
    expect(getAgentTerminalTraits("codex").autoForceMouseMode).toBe(false);
  });

  test("leaves autoForceMouseMode off for the 'unknown' production sentinel", () => {
    expect(getAgentTerminalTraits("unknown").autoForceMouseMode).toBe(false);
  });

  test("leaves autoForceMouseMode off for null", () => {
    expect(getAgentTerminalTraits(null).autoForceMouseMode).toBe(false);
  });

  test("leaves autoForceMouseMode off for undefined", () => {
    expect(getAgentTerminalTraits(undefined).autoForceMouseMode).toBe(false);
  });

  test("leaves autoForceMouseMode off for the empty string", () => {
    expect(getAgentTerminalTraits("").autoForceMouseMode).toBe(false);
  });

  test("leaves autoForceMouseMode off for unrelated identifiers", () => {
    expect(getAgentTerminalTraits("foo-bar").autoForceMouseMode).toBe(false);
  });
});
