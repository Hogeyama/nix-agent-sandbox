/**
 * terminal domain — barrel re-export.
 *
 * 外部 (cli/, ui/) からはこのバレル経由で import する。内部テストは
 * 直接 service.ts を参照してよい。
 */

export {
  type DtachSessionInfo,
  makeTerminalSessionClient,
  makeTerminalSessionServiceFake,
  TerminalSessionService,
  type TerminalSessionServiceFakeConfig,
  TerminalSessionServiceLive,
} from "./terminal/service.ts";
