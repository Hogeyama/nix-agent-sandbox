/**
 * launch domain — barrel re-export.
 *
 * 外部 (ui/) からはこのバレル経由で import する。内部テストは
 * 直接 service.ts を参照してよい。
 */

export {
  type AgentLaunchSpec,
  makeSessionLaunchClient,
  makeSessionLaunchServiceFake,
  SessionLaunchService,
  type SessionLaunchServiceFakeConfig,
  SessionLaunchServiceLive,
  type ShellLaunchContainer,
} from "./launch/service.ts";
