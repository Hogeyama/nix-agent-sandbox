/**
 * display ステージ — barrel re-export
 */

export {
  buildWildXauthorityRecord,
  type DisplayHandle,
  DisplayService,
  type DisplayServiceFakeConfig,
  DisplayServiceLive,
  type DisplayStartPlan,
  extractCookieFromXauthList,
  makeDisplayServiceFake,
} from "./display/display_service.ts";
export {
  createDisplayStage,
  type DisplayPlan,
  pickFreeDisplayNumber,
  planDisplay,
} from "./display/stage.ts";
