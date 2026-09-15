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
