/**
 * mount ステージ — barrel re-export
 */

export {
  ensureDevcontainerAgentState,
  ensureDevcontainerClaudeState,
  ensureDevcontainerCodexState,
} from "./mount/mount_probes.ts";
export {
  type MountDirectoryEntry,
  MountSetupService,
  type MountSetupServiceFakeConfig,
  MountSetupServiceLive,
  makeMountSetupServiceFake,
} from "./mount/mount_setup_service.ts";
export {
  createMountStage,
  type DevcontainerMountInput,
  type MountPlan,
  type MountPlanDirectory,
  type MountProbes,
  planMount,
  type ResolvedEnvEntry,
  type ResolvedExtraMount,
  resolveMountProbes,
} from "./mount/stage.ts";
