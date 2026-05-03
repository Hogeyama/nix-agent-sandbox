import type { ClaudeProbes } from "./claude.ts";
import { configureClaude, resolveClaudeProbes } from "./claude.ts";
import type { CodexProbes } from "./codex.ts";
import { configureCodex, resolveCodexProbes } from "./codex.ts";
import type { CopilotProbes } from "./copilot.ts";
import { configureCopilot, resolveCopilotProbes } from "./copilot.ts";
import type {
  AgentConfigInput,
  AgentConfigResult,
  AgentProbes,
  AgentType,
} from "./types.ts";

export function resolveAgentProbes(
  agent: AgentType,
  hostHome: string,
): AgentProbes {
  switch (agent) {
    case "claude":
      return resolveClaudeProbes(hostHome);
    case "copilot":
      return resolveCopilotProbes(hostHome);
    case "codex":
      return resolveCodexProbes(hostHome);
  }
  throw new Error(`Unknown agent: ${agent}`);
}

export function configureAgent(input: AgentConfigInput): AgentConfigResult {
  switch (input.agent) {
    case "claude":
      return configureClaude({
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectClaudeProbes(input.probes),
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
      });
    case "copilot":
      return configureCopilot({
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectCopilotProbes(input.probes),
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
      });
    case "codex":
      return configureCodex({
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectCodexProbes(input.probes),
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
      });
  }
  throw new Error(`Unknown agent: ${input.agent}`);
}

function expectClaudeProbes(probes: AgentProbes): ClaudeProbes {
  if (
    "claudeDirExists" in probes &&
    "claudeJsonExists" in probes &&
    "claudeBinPath" in probes
  ) {
    return probes;
  }
  throw new Error("Agent probe mismatch: expected claude probes");
}

function expectCopilotProbes(probes: AgentProbes): CopilotProbes {
  if ("copilotBinPath" in probes && "copilotLegacyDirExists" in probes) {
    return probes;
  }
  throw new Error("Agent probe mismatch: expected copilot probes");
}

function expectCodexProbes(probes: AgentProbes): CodexProbes {
  if ("codexDirExists" in probes && "codexBinPath" in probes) {
    return probes;
  }
  throw new Error("Agent probe mismatch: expected codex probes");
}
