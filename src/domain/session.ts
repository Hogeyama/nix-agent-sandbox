/**
 * session domain — barrel re-export.
 *
 * 外部 (cli/, ui/) からはこのバレル経由で import する。内部テストは
 * 直接 service.ts を参照してよい。
 */

export {
  makeSessionUiClient,
  makeSessionUiServiceFake,
  SessionUiService,
  type SessionUiServiceFakeConfig,
  SessionUiServiceLive,
} from "./session/service.ts";
