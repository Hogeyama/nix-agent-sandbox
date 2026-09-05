/**
 * guide ステージ — barrel re-export
 */

export { GUIDE_SKILL_NAME, renderGuide } from "./guide/content.ts";
export { type GuideFacts, profileToGuideFacts } from "./guide/facts.ts";
export {
  GuideService,
  type GuideServiceFake,
  type GuideServiceFakeConfig,
  GuideServiceLive,
  type GuideWritePlan,
  makeGuideServiceFake,
} from "./guide/guide_service.ts";
export {
  createGuideStage,
  GUIDE_CLAUDE_ADD_DIR,
  type GuidePlan,
  type GuideStageInput,
  planGuide,
} from "./guide/stage.ts";
