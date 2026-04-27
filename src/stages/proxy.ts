/**
 * proxy ステージ — barrel re-export
 */

export {
  type AuthRouterHandle,
  AuthRouterService,
  type AuthRouterServiceFakeConfig,
  AuthRouterServiceLive,
  makeAuthRouterServiceFake,
} from "./proxy/auth_router_service.ts";
export {
  type EnsureEnvoyPlan,
  EnvoyService,
  type EnvoyServiceFakeConfig,
  EnvoyServiceLive,
  makeEnvoyServiceFake,
  type SessionNetworkPlan,
} from "./proxy/envoy_service.ts";
export {
  type EnsureForwardPortRelaysOptions,
  type ForwardPortRelayHandle,
  ForwardPortRelayService,
  type ForwardPortRelayServiceFakeConfig,
  ForwardPortRelayServiceLive,
  makeForwardPortRelayServiceFake,
} from "./proxy/forward_port_relay_service.ts";
export {
  makeNetworkRuntimeServiceFake,
  NetworkRuntimeService,
  type NetworkRuntimeServiceFakeConfig,
  NetworkRuntimeServiceLive,
} from "./proxy/network_runtime_service.ts";
export {
  makeSessionBrokerServiceFake,
  type SessionBrokerConfig,
  type SessionBrokerHandle,
  SessionBrokerService,
  type SessionBrokerServiceFakeConfig,
  SessionBrokerServiceLive,
} from "./proxy/session_broker_service.ts";
export {
  buildNetworkRuntimePaths,
  createProxyStage,
  createProxyStageWithOptions,
  LOCAL_PROXY_PORT,
  type ProxyPlan,
  type ProxyStageOptions,
  planProxy,
  replaceNetwork,
} from "./proxy/stage.ts";
