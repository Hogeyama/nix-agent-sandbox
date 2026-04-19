/**
 * mount ステージ — barrel re-export
 */

export {
  type MountDirectoryEntry,
  MountSetupService,
  type MountSetupServiceFakeConfig,
  MountSetupServiceLive,
  makeMountSetupServiceFake,
} from "./mount/mount_setup_service.ts";
export {
  createMountStage,
  type MountPlan,
  type MountPlanDirectory,
  type MountProbes,
  planMount,
  type ResolvedEnvEntry,
  type ResolvedExtraMount,
  resolveMountProbes,
  serializeNixExtraPackages,
} from "./mount/stage.ts";
