/**
 * launch ステージ — barrel re-export
 */

export {
  type ComposeAgentService,
  type ComposeBindMount,
  type ComposeDocument,
  compileCompose,
  serializeCompose,
} from "./launch/compose.ts";
export {
  ComposeSessionOps,
  type ComposeSessionRequest,
  ComposeSessionService,
  type ComposeSessionServiceApi,
  type ComposeSessionServiceFakeConfig,
  completeComposeSession,
  makeComposeSessionOpsLive,
  makeComposeSessionServiceFake,
  makeComposeSessionServiceLive,
  serveComposeSession,
} from "./launch/compose_session_service.ts";
export {
  type ComposeStageOptions,
  createComposeStage,
  finalizeDevcontainerPlan,
} from "./launch/compose_stage.ts";
export {
  ContainerLaunchService,
  type ContainerLaunchServiceFakeConfig,
  ContainerLaunchServiceLive,
  type LaunchOpts,
  makeContainerLaunchServiceFake,
} from "./launch/container_launch_service.ts";
export {
  compareLaunchInspection,
  type ExpectedLaunchInspection,
} from "./launch/inspection.ts";
export {
  type FinalizedLaunchPlan,
  finalizeLaunchPlan,
} from "./launch/plan.ts";
export {
  compileLaunchOpts,
  createLaunchStage,
  type LaunchPlan,
  planLaunch,
} from "./launch/stage.ts";
