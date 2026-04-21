/**
 * network domain — barrel re-export.
 *
 * 外部 (cli/, ui/) からはこのバレル経由で import する。内部テストは
 * 直接 service.ts を参照してよい。
 */

export {
  makeNetworkApprovalClient,
  makeNetworkApprovalServiceFake,
  NetworkApprovalService,
  type NetworkApprovalServiceFakeConfig,
  NetworkApprovalServiceLive,
} from "./network/service.ts";
