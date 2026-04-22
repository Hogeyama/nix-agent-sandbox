/**
 * container domain — barrel re-export.
 *
 * 外部 (cli/, ui/) からはこのバレル経由で import する。内部テストは
 * 直接 service.ts を参照してよい。
 */

export {
  ContainerQueryService,
  type ContainerQueryServiceFakeConfig,
  ContainerQueryServiceLive,
  makeContainerQueryClient,
  makeContainerQueryServiceFake,
} from "./container/service.ts";
export {
  joinSessionsToContainers,
  type NasContainerInfo,
} from "./container/types.ts";
