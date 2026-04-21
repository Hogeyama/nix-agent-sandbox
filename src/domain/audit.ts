/**
 * audit domain — barrel re-export.
 *
 * 外部 (cli/, ui/) からはこのバレル経由で import する。内部テストは
 * 直接 service.ts を参照してよい。
 */

export {
  AuditQueryService,
  type AuditQueryServiceFakeConfig,
  AuditQueryServiceLive,
  makeAuditQueryClient,
  makeAuditQueryServiceFake,
} from "./audit/service.ts";
