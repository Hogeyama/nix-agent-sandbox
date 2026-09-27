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

/**
 * Host `~/.claude` state exposed through a private, per-session container
 * root instead of a direct bind of the host directory. Used both for
 * `agentState.protectSettings` (protected mode) and whenever Claude
 * credentials are proxied, so a dummy credentials file can be bind-mounted
 * in place of the real one without a read-write bind of the host directory
 * underneath it.
 */
export interface ProtectedClaudeState {
  readonly runtimeDir: string;
  readonly claudeJson: string;
  readonly entries: readonly {
    readonly source: string;
    readonly name: string;
    readonly readOnly: boolean;
  }[];
}

export interface CodexStatePaths {
  readonly codexDir: string;
}

/**
 * Host agent state pre-created for a Dev Container session. A session whose
 * IDE agent set includes both Claude and Codex carries both members at once;
 * one may still be absent when the other agent is not in that set.
 */
export interface DevcontainerAgentState {
  readonly claudeState?: ClaudeStatePaths;
  readonly codexState?: CodexStatePaths;
}

/**
 * provisionAgent 系の共通出力。エージェントを起動せずコンテナ内で使える
 * ようにするマウントと環境変数だけを持つ。
 */
export interface AgentProvisionResult {
  readonly mounts?: readonly MountSpec[];
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
}

/** configureAgent 系の共通出力。provision に起動時の設定を足したもの。 */
export interface AgentConfigResult extends AgentProvisionResult {
  readonly agentCommand: string[];
}

/** configureAgent 系の共通入力 */
export interface AgentConfigInput extends AgentProvisionInput {
  readonly mode: AgentMode;
}

/**
 * provisionAgent 系の共通入力。Dev Container の IDE 状態パスは、その
 * エージェントが主・追加どちらであっても渡せる (`claudeState` /
 * `codexState`)。`mountHostBinary` は状態の有無と独立にホスト CLI を
 * mount するかを決める: 未指定なら対応する state が無いときだけ true
 * になる (通常 CLI の既定と同じ)。IDE 拡張は state の有無にかかわらず
 * 同梱バイナリを使うため、mount の要否は呼び出し側 (registry / mount
 * stage) が明示する。
 */
export interface AgentProvisionInput {
  readonly protectedClaudeState?: ProtectedClaudeState;
  readonly agent: AgentType;
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
  /**
   * container の `~/.claude/.credentials.json` に bind mount するダミーファイルの、
   * host 上のパスである。ホストの credential を proxy で注入するときに渡す。
   */
  readonly claudeCredentialsFile?: string;
  /**
   * container の `~/.codex/auth.json` に bind mount するダミーファイルの、
   * host 上のパスである。ホストの credential を proxy で注入するときに渡す。
   */
  readonly codexAuthFile?: string;
  /** Dev Container の Claude IDE 状態。この agent が Claude のときだけ使う。 */
  readonly claudeState?: ClaudeStatePaths;
  /** Dev Container の Codex IDE 状態。この agent が Codex のときだけ使う。 */
  readonly codexState?: CodexStatePaths;
  /**
   * ホスト CLI バイナリを mount するか。未指定なら、対応する IDE state
   * (`claudeState` / `codexState`) が無いときだけ true。
   */
  readonly mountHostBinary?: boolean;
}

/** エージェント固有 probe 結果 */
export type AgentProbes = ClaudeProbes | CopilotProbes | CodexProbes;
