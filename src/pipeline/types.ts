/**
 * Stage アーキテクチャの型定義
 */

import type { Effect, Scope } from "effect";
import type { Config, Profile } from "../config/types.ts";
import type { AuthRouterService } from "../services/auth_router.ts";
import type { DbusProxyService } from "../services/dbus_proxy.ts";
import type { DindService } from "../services/dind.ts";
import type { DockerService } from "../services/docker.ts";
import type { DockerBuildService } from "../services/docker_build.ts";
import type { EnvoyService } from "../services/envoy.ts";
import type { FsService } from "../services/fs.ts";
import type { GitWorktreeService } from "../services/git_worktree.ts";
import type { HostExecBrokerService } from "../services/hostexec_broker.ts";
import type { NetworkRuntimeService } from "../services/network_runtime.ts";
import type { ProcessService } from "../services/process.ts";
import type { SessionBrokerService } from "../services/session_broker.ts";
import type { SessionStoreService } from "../services/session_store_service.ts";
import type { PromptService } from "../stages/worktree/prompt_service.ts";

// ---------------------------------------------------------------------------
// Host environment & probes
// ---------------------------------------------------------------------------

/** CLI 層が起動時に 1 回解決するホスト環境情報 */
export interface HostEnv {
  readonly home: string;
  readonly user: string;
  readonly uid: number | null;
  readonly gid: number | null;
  readonly isWSL: boolean;
  readonly env: ReadonlyMap<string, string>;
}

/** pipeline 開始時に並列解決される probe 結果 */
export interface ProbeResults {
  readonly hasHostNix: boolean;
  readonly xdgDbusProxyPath: string | null;
  readonly dbusSessionAddress: string | null;
  readonly gpgAgentSocket: string | null;
  readonly auditDir: string;
}

// ---------------------------------------------------------------------------
// Stage input & output
// ---------------------------------------------------------------------------

/** 各 stage に渡される不変の入力 */
export interface StageInput {
  readonly config: Config;
  readonly profile: Profile;
  readonly profileName: string;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly host: HostEnv;
  readonly probes: ProbeResults;
  readonly prior: PriorStageOutputs;
}

/** stage 間で蓄積される出力 */
export interface PriorStageOutputs {
  readonly dockerArgs: readonly string[];
  readonly envVars: Readonly<Record<string, string>>;
  readonly workDir: string;
  readonly mountDir?: string;
  readonly nixEnabled: boolean;
  readonly imageName: string;
  readonly agentCommand: readonly string[];
  readonly dindContainerName?: string;
  readonly networkName?: string;
  readonly networkRuntimeDir?: string;
  readonly networkPromptToken?: string;
  readonly networkPromptEnabled: boolean;
  readonly networkBrokerSocket?: string;
  readonly networkProxyEndpoint?: string;
  readonly hostexecRuntimeDir?: string;
  readonly hostexecBrokerSocket?: string;
  readonly hostexecSessionTmpDir?: string;
  readonly dbusProxyEnabled: boolean;
  readonly dbusSessionRuntimeDir?: string;
  readonly dbusSessionSocket?: string;
  readonly dbusSessionSourceAddress?: string;
}

// ---------------------------------------------------------------------------
// Effect-based stage types
// ---------------------------------------------------------------------------

// Effect stage result — partial outputs to merge into prior
export type EffectStageResult = Partial<PriorStageOutputs>;

// Union of all service tags that stages can depend on
export type StageServices =
  | DbusProxyService
  | DindService
  | DockerBuildService
  | EnvoyService
  | FsService
  | GitWorktreeService
  | HostExecBrokerService
  | NetworkRuntimeService
  | ProcessService
  | DockerService
  | PromptService
  | SessionBrokerService
  | SessionStoreService
  | AuthRouterService;

// A stage that runs as an Effect
export interface EffectStage<R extends StageServices = never> {
  kind: "effect";
  name: string;
  run(
    input: StageInput,
  ): Effect.Effect<EffectStageResult, unknown, Scope.Scope | R>;
}

// Extract service requirements from a stage
export type StageServicesOf<TStage extends EffectStage<StageServices>> =
  TStage extends EffectStage<infer R extends StageServices> ? R : never;

// Compute pipeline requirements from a tuple of stages
export type PipelineRequirements<
  TStages extends readonly EffectStage<StageServices>[],
> = Scope.Scope | StageServicesOf<TStages[number]>;

/** すべての stage の union type */
export type AnyStage = EffectStage<StageServices>;
