/**
 * dind ステージ — barrel re-export
 */

export {
  DindService,
  type DindServiceFakeConfig,
  DindServiceLive,
  type DindSidecarOpts,
  makeDindServiceFake,
} from "./dind/dind_service.ts";
export {
  buildDindSidecarArgs,
  createDindStage,
  createDindStageWithOptions,
  type DindPlan,
  type DindStageOptions,
  type DindStagePlanOptions,
  planDind,
} from "./dind/stage.ts";
