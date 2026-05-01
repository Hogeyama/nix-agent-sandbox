/**
 * observability ステージ — barrel re-export
 */

export {
  makeOtlpReceiverServiceFake,
  OtlpReceiverService,
  OtlpReceiverServiceLive,
} from "./observability/receiver_service.ts";
export {
  createObservabilityStage,
  type ObservabilityStageDeps,
  shouldEnableObservability,
} from "./observability/stage.ts";
