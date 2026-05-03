import type { ClaudeProbes } from "./claude.ts";
import type { CodexProbes } from "./codex.ts";
import type { CopilotProbes } from "./copilot.ts";

/** エージェント種別 */
export type AgentType = "claude" | "copilot" | "codex";

/** configureAgent 系の共通出力 */
export interface AgentConfigResult {
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly agentCommand: string[];
}

/** configureAgent 系の共通入力 */
export interface AgentConfigInput {
  readonly agent: AgentType;
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: AgentProbes;
  readonly priorDockerArgs: readonly string[];
  readonly priorEnvVars: Readonly<Record<string, string>>;
}

/** エージェント固有 probe 結果 */
export type AgentProbes = ClaudeProbes | CopilotProbes | CodexProbes;
