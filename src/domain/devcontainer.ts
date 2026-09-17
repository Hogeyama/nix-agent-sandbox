export { renderDevcontainerConfig } from "./devcontainer/config.ts";
export {
  type DevcontainerDisclosure,
  type DevcontainerInitResult,
  describeDevcontainerSharing,
} from "./devcontainer/disclosure.ts";
export {
  type DevcontainerLifecycleOptions,
  devcontainerRuntimeIsRunning,
  makeDevcontainerLifecycle,
  markDevcontainerFailure,
  type ServeDevcontainerRuntimeOptions,
  serveDevcontainerRuntime,
  spawnDetachedDevcontainerRuntime,
} from "./devcontainer/lifecycle.ts";
export { validateDevcontainerProfile } from "./devcontainer/policy.ts";
export {
  acquireDevcontainerLock,
  canonicalizeWorkspace,
  type DevcontainerInputs,
  devcontainerWorkspaceId,
  loadDevcontainerInputs,
  readDevcontainerRegistration,
  readDevcontainerSession,
  requireHostUid,
  resolveDevcontainerPaths,
  resolveDevcontainerRuntimePaths,
  withDevcontainerOperationLock,
  writeDevcontainerSession,
} from "./devcontainer/store.ts";
export type {
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
