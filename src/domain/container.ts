/**
 * container domain — barrel re-export.
 *
 * 外部 (cli/, ui/) からはこのバレル経由で import する。内部テストは
 * 直接 service.ts を参照してよい。
 *
 * Note: `NasContainerInfo` / `joinSessionsToContainers` は当面 `ui/data.ts`
 * 残置。Phase 3 Commit 3 で `domain/container/types.ts` に移設してこの
 * バレルから export する予定。
 */

export {
  ContainerQueryService,
  type ContainerQueryServiceFakeConfig,
  ContainerQueryServiceLive,
  makeContainerQueryClient,
  makeContainerQueryServiceFake,
} from "./container/service.ts";
