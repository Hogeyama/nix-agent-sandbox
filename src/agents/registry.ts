import type { ClaudeProbes } from "./claude.ts";
import {
  configureClaude,
  provisionClaude,
  resolveClaudeProbes,
} from "./claude.ts";
import type { CodexProbes } from "./codex.ts";
import { configureCodex, provisionCodex, resolveCodexProbes } from "./codex.ts";
import type { CopilotProbes } from "./copilot.ts";
import {
  configureCopilot,
  provisionCopilot,
  resolveCopilotProbes,
} from "./copilot.ts";
import type {
  AgentConfigInput,
  AgentConfigResult,
  AgentProbes,
  AgentProvisionInput,
  AgentProvisionResult,
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

/** ホストでエージェントのバイナリが見つかったか */
export function agentBinaryFound(
  agent: AgentType,
  probes: AgentProbes,
): boolean {
  switch (agent) {
    case "claude":
      return expectClaudeProbes(probes).claudeBinPath !== null;
    case "copilot":
      return expectCopilotProbes(probes).copilotBinPath !== null;
    case "codex":
      return expectCodexProbes(probes).codexBinPath !== null;
  }
  throw new Error(`Unknown agent: ${agent}`);
}

/**
 * エージェントを起動せずにコンテナ内で使えるようにする (extraAgents 用)。
 * 起動コマンドも、起動するときだけ要る環境変数も返さない。
 */
export function provisionAgent(
  input: AgentProvisionInput,
): AgentProvisionResult {
  switch (input.agent) {
    case "claude":
      return provisionClaude({
        protectedClaudeState: input.protectedClaudeState,
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectClaudeProbes(input.probes),
        protectSettings: input.protectSettings,
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
        claudeCredentialsFile: input.claudeCredentialsFile,
      });
    case "copilot":
      return provisionCopilot({
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectCopilotProbes(input.probes),
        protectSettings: input.protectSettings,
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
      });
    case "codex":
      return provisionCodex({
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectCodexProbes(input.probes),
        protectSettings: input.protectSettings,
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
        codexAuthFile: input.codexAuthFile,
      });
  }
  throw new Error(`Unknown agent: ${input.agent}`);
}

export function configureAgent(input: AgentConfigInput): AgentConfigResult {
  switch (input.agent) {
    case "claude":
      return configureClaude({
        mode: input.mode,
        claudeState: input.claudeState,
        protectedClaudeState: input.protectedClaudeState,
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectClaudeProbes(input.probes),
        protectSettings: input.protectSettings,
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
        claudeCredentialsFile: input.claudeCredentialsFile,
      });
    case "copilot":
      if (input.mode !== "terminal") {
        throw new Error('ACP mode currently supports only agent "claude"');
      }
      return configureCopilot({
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectCopilotProbes(input.probes),
        protectSettings: input.protectSettings,
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
      });
    case "codex":
      if (input.mode !== "terminal") {
        throw new Error('ACP mode currently supports only agent "claude"');
      }
      return configureCodex({
        codexState: input.codexState,
        containerHome: input.containerHome,
        hostHome: input.hostHome,
        probes: expectCodexProbes(input.probes),
        protectSettings: input.protectSettings,
        priorDockerArgs: input.priorDockerArgs,
        priorEnvVars: input.priorEnvVars,
        codexAuthFile: input.codexAuthFile,
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
  if (
    "codexDirExists" in probes &&
    "codexBinPath" in probes &&
    "codexCodeModeHostBinPath" in probes
  ) {
    return probes;
  }
  throw new Error("Agent probe mismatch: expected codex probes");
}
