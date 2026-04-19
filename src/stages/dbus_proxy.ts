/**
 * dbus_proxy ステージ — barrel re-export
 */

export {
  type DbusProxyHandle,
  DbusProxyService,
  type DbusProxyServiceFakeConfig,
  DbusProxyServiceLive,
  type DbusProxyStartPlan,
  makeDbusProxyServiceFake,
} from "./dbus_proxy/dbus_proxy_service.ts";
export {
  buildProxyArgs,
  createDbusProxyStage,
  type DbusProxyPlan,
  isValidUnixPathAddress,
  resolveRuntimeDir,
  resolveSourceAddress,
} from "./dbus_proxy/stage.ts";
