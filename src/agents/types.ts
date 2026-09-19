import type { MountSpec } from "../pipeline/state.ts";
import type { ClaudeProbes } from "./claude.ts";
import type { CodexProbes } from "./codex.ts";
import type { CopilotProbes } from "./copilot.ts";

/** エージェント種別 */
export type AgentType = "claude" | "copilot" | "codex";
export type AgentMode = "terminal" | "acp";

export interface ClaudeStatePaths {
  readonly claudeDir: string;
  readonly claudeJson: string;
}

/** Host state exposed through a private, writable container state root. */
export interface ProtectedClaudeState {
  readonly runtimeDir: string;
  readonly claudeJson: string;
  readonly entries: readonly {
    readonly source: string;
    readonly name: string;
    readonly readOnly: boolean;
  }[];
}

/** configureAgent 系の共通出力 */
export interface AgentConfigResult {
  readonly mounts?: readonly MountSpec[];
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly agentCommand: string[];
}

/** configureAgent 系の共通入力 */
export interface AgentConfigInput {
  readonly claudeState?: ClaudeStatePaths;
  readonly protectedClaudeState?: ProtectedClaudeState;
  readonly agent: AgentType;
  readonly mode: AgentMode;
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: AgentProbes;
  /**
   * エージェントの状態ディレクトリ配下の設定ファイルを RO で上乗せするか
   * (`profile.agentState.protectSettings`)。Claude は設定ディレクトリも含む。
   */
  readonly protectSettings: boolean;
  readonly priorDockerArgs: readonly string[];
  readonly priorEnvVars: Readonly<Record<string, string>>;
}

/** エージェント固有 probe 結果 */
export type AgentProbes = ClaudeProbes | CopilotProbes | CodexProbes;
