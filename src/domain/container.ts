/**
 * container domain — barrel re-export.
 *
 * 外部 (cli/, ui/) からはこのバレル経由で import する。内部テストは
 * 直接 service.ts / lifecycle_service.ts を参照してよい。
 */

export {
  ContainerLifecycleService,
  type ContainerLifecycleServiceFakeConfig,
  ContainerLifecycleServiceLive,
  makeContainerLifecycleClient,
  makeContainerLifecycleServiceFake,
} from "./container/lifecycle_service.ts";
export {
  ContainerQueryService,
  type ContainerQueryServiceFakeConfig,
  ContainerQueryServiceLive,
  makeContainerQueryClient,
  makeContainerQueryServiceFake,
} from "./container/service.ts";
export {
  ContainerNotRunningError,
  joinSessionsToContainers,
  type NasContainerInfo,
  NotNasManagedContainerError,
} from "./container/types.ts";
