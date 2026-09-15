export {
  computeDevcontainerFingerprint,
  renderDevcontainerConfig,
} from "./devcontainer/config.ts";
export {
  pathContains,
  pathsOverlap,
  validateDevcontainerMount,
  validateDevcontainerProfile,
} from "./devcontainer/policy.ts";
export {
  DevcontainerService,
  type DevcontainerServiceFakeConfig,
  makeDevcontainerClient,
  makeDevcontainerServiceFake,
  makeDevcontainerServiceLive,
} from "./devcontainer/service.ts";
export {
  acquireDevcontainerLock,
  canonicalizePotentialPath,
  canonicalizeWorkspace,
  type DevcontainerInputs,
  DevcontainerStoreOps,
  devcontainerWorkspaceId,
  ensureProtectedDirectory,
  loadDevcontainerInputs,
  makeDevcontainerStoreOpsFake,
  makeDevcontainerStoreOpsLive,
  readDevcontainerRegistration,
  readDevcontainerSession,
  readProtectedFile,
  requireHostUid,
  resolveDevcontainerPaths,
  resolveDevcontainerRuntimePaths,
  withDevcontainerOperationLock,
  writeDevcontainerSession,
  writeProtectedFile,
} from "./devcontainer/store.ts";
export {
  cleanupOwnedDevcontainer,
  type DevcontainerRuntimeOutcome,
  type DevcontainerSupervisorOptions,
  inspectOwnedDevcontainer,
  makeDevcontainerSupervisorClient,
  markSupervisorFailure,
  requestDevcontainerControl,
  type ServeDevcontainerSupervisorOptions,
  serveDevcontainerSupervisor,
  spawnDetachedDevcontainerSupervisor,
} from "./devcontainer/supervisor.ts";
export type {
  DevcontainerMountPolicy,
  DevcontainerPaths,
  DevcontainerPhase,
  DevcontainerRegistration,
  DevcontainerRuntimePaths,
  DevcontainerSessionRecord,
  DevcontainerStatus,
} from "./devcontainer/types.ts";
export {
  DevcontainerError,
  projectDevcontainerStatus,
} from "./devcontainer/types.ts";
