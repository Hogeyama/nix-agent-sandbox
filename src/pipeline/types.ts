/**
 * Stage アーキテクチャの型定義
 */

import type { Config, Profile } from "../config/types.ts";
import type { AuthRouterService } from "../services/auth_router.ts";
import type { ContainerLaunchService } from "../services/container_launch.ts";
import type { DbusProxyService } from "../services/dbus_proxy.ts";
import type { DindService } from "../services/dind.ts";
import type { DisplayService } from "../services/display.ts";
import type { DockerService } from "../services/docker.ts";
import type { DockerBuildService } from "../services/docker_build.ts";
import type { EnvoyService } from "../services/envoy.ts";
import type { FsService } from "../services/fs.ts";
import type { GitWorktreeService } from "../services/git_worktree.ts";
import type { HostExecBrokerService } from "../services/hostexec_broker.ts";
import type { HostExecSetupService } from "../services/hostexec_setup.ts";
import type { MountSetupService } from "../services/mount_setup.ts";
import type { NetworkRuntimeService } from "../services/network_runtime.ts";
import type { ProcessService } from "../services/process.ts";
import type { SessionBrokerService } from "../services/session_broker.ts";
import type { SessionStoreService } from "../services/session_store_service.ts";
import type { PromptService } from "../stages/worktree/prompt_service.ts";
import type { PipelineState } from "./state.ts";

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
}

// ---------------------------------------------------------------------------
// Pipeline stage types
// ---------------------------------------------------------------------------

/** Stage result — stages return only the slices they modify */
export type StageResult = Partial<PipelineState>;

// Union of all service tags that stages can depend on
export type StageServices =
  | ContainerLaunchService
  | DbusProxyService
  | DindService
  | DisplayService
  | DockerBuildService
  | EnvoyService
  | FsService
  | GitWorktreeService
  | HostExecBrokerService
  | HostExecSetupService
  | MountSetupService
  | NetworkRuntimeService
  | ProcessService
  | DockerService
  | PromptService
  | SessionBrokerService
  | SessionStoreService
  | AuthRouterService;
