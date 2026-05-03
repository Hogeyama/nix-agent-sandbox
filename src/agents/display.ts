/**
 * Browser-safe display helpers for agent and history UI labels.
 *
 * This module intentionally has no imports. Frontend code may import it
 * directly without pulling server-only agent implementations into the bundle.
 */

export interface ToolDisplaySpan {
  readonly kind: string;
  readonly spanName: string;
  readonly attrsJson: string;
}

/**
 * Map the raw backend agent string to a stable CSS class fragment.
 * Returns `"is-claude" | "is-copilot" | "is-codex" | ""`.
 */
export function classifyAgent(agent: string | null): string {
  if (agent === null) return "";
  const lower = agent.toLowerCase();
  if (lower.includes("claude")) return "is-claude";
  if (lower.includes("copilot")) return "is-copilot";
  if (lower.includes("codex")) return "is-codex";
  return "";
}

export function bareAgentLabel(agent: string | null): string {
  if (agent === null) return "";
  const lower = agent.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("copilot")) return "copilot";
  if (lower.includes("codex")) return "codex";
  return agent;
}

/**
 * Extract a display tool name from an `execute_tool` span.
 *
 * Gated on `kind === "execute_tool"` so chat spans that happen to carry a
 * `tool_name`-shaped attribute (e.g. function-calling parameter echoes) do
 * not bleed into the tool column.
 */
export function extractToolName(span: ToolDisplaySpan): string | null {
  if (span.kind !== "execute_tool") return null;
  let attrs: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(span.attrsJson);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      attrs = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  if (attrs !== null) {
    const keys = ["tool_name", "gen_ai.tool.name", "claude_code.tool.name"];
    for (const key of keys) {
      const v = attrs[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  const execMatch = /^execute_tool\s+(.+)$/.exec(span.spanName);
  if (execMatch !== null) return execMatch[1] ?? null;
  const ccMatch = /^claude_code\.tool\.(.+)$/.exec(span.spanName);
  if (ccMatch !== null) return ccMatch[1] ?? null;
  return null;
}

/**
 * Extract an inline display detail for the Task/Agent tool span, used to
 * disambiguate parallel sub-agents kicked off in one turn.
 */
export function extractToolDetail(span: ToolDisplaySpan): string | null {
  if (span.kind !== "execute_tool") return null;
  const toolName = extractToolName(span);
  if (toolName !== "Task" && toolName !== "Agent") return null;
  let attrs: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(span.attrsJson);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      attrs = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  if (attrs === null) return null;

  const subagent =
    typeof attrs.subagent_type === "string" ? attrs.subagent_type.trim() : "";

  const rawToolInput = attrs.tool_input;
  if (typeof rawToolInput === "string") {
    try {
      const parsedInput = JSON.parse(rawToolInput);
      if (
        parsedInput !== null &&
        typeof parsedInput === "object" &&
        !Array.isArray(parsedInput)
      ) {
        const toolInput = parsedInput as Record<string, unknown>;
        const description =
          typeof toolInput.description === "string"
            ? toolInput.description.trim()
            : "";
        const prompt =
          typeof toolInput.prompt === "string" ? toolInput.prompt.trim() : "";
        const base = description.length > 0 ? description : prompt;
        if (base.length > 0) {
          return subagent.length === 0 ? base : `${base} (${subagent})`;
        }
      }
    } catch {
      // Malformed tool_input JSON: fall through to subagent-only display.
    }
  }

  return subagent.length === 0 ? null : subagent;
}
