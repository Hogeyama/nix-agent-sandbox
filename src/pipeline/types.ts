/**
 * Stage アーキテクチャの型定義
 */

import type { Config, Profile } from "../config/types.ts";
import type { AuthRouterService } from "../stages/proxy.ts";
import type { DbusProxyService } from "../stages/dbus_proxy.ts";
import type { DindService } from "../stages/dind.ts";
import type { DisplayService } from "../stages/display.ts";
import type { DockerService } from "../services/docker.ts";
import type { DockerBuildService } from "../stages/docker_build.ts";
import type { EnvoyService } from "../stages/proxy.ts";
import type { FsService } from "../services/fs.ts";
import type { HostExecBrokerService } from "../stages/hostexec.ts";
import type { HostExecSetupService } from "../stages/hostexec.ts";
import type { NetworkRuntimeService } from "../stages/proxy.ts";
import type { ProcessService } from "../services/process.ts";
import type { SessionBrokerService } from "../stages/proxy.ts";
import type { ContainerLaunchService } from "../stages/launch.ts";
import type { MountSetupService } from "../stages/mount.ts";
import type { SessionStoreService } from "../stages/session_store.ts";
import type { GitWorktreeService } from "../stages/worktree.ts";
import type { PromptService } from "../stages/worktree.ts";
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
