/**
 * ProxyStage (PlanStage)
 *
 * 共有 Envoy コンテナ + auth-router + session network + session broker を
 * セットアップし、エージェントコンテナのネットワークトラフィックを
 * allowlist/prompt ベースで制御する。
 *
 * plan() は skip 判定と設定の計算のみ行い、全ての副作用は
 * proxy-session effect として executor に委譲する。
 */

import * as path from "node:path";
import type {
  HostEnv,
  PlanStage,
  ResourceEffect,
  StageInput,
  StagePlan,
} from "../pipeline/types.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import { resolveNotifyBackend } from "../lib/notify_utils.ts";
import { generateSessionToken as defaultGenerateToken } from "../network/protocol.ts";
import { logInfo } from "../log.ts";

const ENVOY_IMAGE = "envoyproxy/envoy:v1.37.1";
const ENVOY_CONTAINER_NAME = "nas-envoy-shared";
const ENVOY_ALIAS = "nas-envoy";
const ENVOY_PROXY_PORT = 15001;
const ENVOY_READY_TIMEOUT_MS = 15_000;
export const LOCAL_PROXY_PORT = 18080;

// ---------------------------------------------------------------------------
// PlanStage
// ---------------------------------------------------------------------------

export interface ProxyStageOptions {
  envoyContainerName?: string;
  /** Injectable token generator (defaults to CSPRNG-based generateSessionToken). */
  generateSessionToken?: () => string;
}

export function createProxyStage(
  options: ProxyStageOptions = {},
): PlanStage {
  const envoyContainerName = options.envoyContainerName ??
    ENVOY_CONTAINER_NAME;
  const generateSessionToken = options.generateSessionToken ??
    defaultGenerateToken;

  return {
    kind: "plan",
    name: "ProxyStage",

    plan(input: StageInput): StagePlan | null {
      if (!isProxyEnabled(input)) {
        logInfo("[nas] Proxy: skipped (allowlist/prompt disabled)");
        return null;
      }

      const runtimePaths = buildNetworkRuntimePaths(input.host);
      const brokerSocket = path.join(
        runtimePaths.brokersDir,
        `${input.sessionId}.sock`,
      );
      const prompt = input.profile.network.prompt;
      const token = input.prior.networkPromptToken ?? generateSessionToken();
      const sessionNetworkName = `nas-session-net-${input.sessionId}`;

      const dindContainerName = parseDindContainerName(input.prior.envVars);

      const effects: ResourceEffect[] = [
        {
          kind: "proxy-session",
          envoyContainerName,
          envoyImage: ENVOY_IMAGE,
          envoyAlias: ENVOY_ALIAS,
          envoyProxyPort: ENVOY_PROXY_PORT,
          envoyReadyTimeoutMs: ENVOY_READY_TIMEOUT_MS,
          sessionId: input.sessionId,
          sessionNetworkName,
          profileName: input.profileName,
          agent: input.profile.agent,
          runtimePaths,
          brokerSocket,
          token,
          allowlist: input.profile.network.allowlist,
          denylist: prompt.denylist,
          promptEnabled: prompt.enable,
          timeoutSeconds: prompt.timeoutSeconds,
          defaultScope: prompt.defaultScope,
          notify: resolveNotifyBackend(prompt.notify),
          uiEnabled: input.config.ui.enable,
          uiPort: input.config.ui.port,
          uiIdleTimeout: input.config.ui.idleTimeout,
          auditDir: input.probes.auditDir,
          dindContainerName,
        },
      ];

      const proxyUrl =
        `http://${input.sessionId}:${token}@${ENVOY_ALIAS}:${ENVOY_PROXY_PORT}`;
      const localProxyUrl = `http://127.0.0.1:${LOCAL_PROXY_PORT}`;
      const noProxyEntries = ["localhost", "127.0.0.1"];
      if (dindContainerName) {
        noProxyEntries.push(dindContainerName);
      }

      return {
        effects,
        dockerArgs: replaceNetwork(
          [...input.prior.dockerArgs],
          sessionNetworkName,
        ),
        envVars: {
          NAS_UPSTREAM_PROXY: proxyUrl,
          http_proxy: localProxyUrl,
          https_proxy: localProxyUrl,
          HTTP_PROXY: localProxyUrl,
          HTTPS_PROXY: localProxyUrl,
          no_proxy: noProxyEntries.join(","),
          NO_PROXY: noProxyEntries.join(","),
        },
        outputOverrides: {
          networkRuntimeDir: runtimePaths.runtimeDir,
          networkPromptToken: token,
          networkPromptEnabled: prompt.enable,
          networkBrokerSocket: brokerSocket,
          networkProxyEndpoint: proxyUrl,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isProxyEnabled(input: StageInput): boolean {
  return input.profile.network.allowlist.length > 0 ||
    input.profile.network.prompt.enable;
}

/**
 * Compute NetworkRuntimePaths from HostEnv (pure, no I/O).
 * Directory creation is handled by the effect executor.
 */
export function buildNetworkRuntimePaths(
  host: HostEnv,
): NetworkRuntimePaths {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  let runtimeDir: string;
  if (xdg && xdg.trim().length > 0) {
    runtimeDir = path.join(xdg, "nas", "network");
  } else {
    const uid = host.uid ?? "unknown";
    runtimeDir = path.join("/tmp", `nas-${uid}`, "network");
  }
  return {
    runtimeDir,
    sessionsDir: path.join(runtimeDir, "sessions"),
    pendingDir: path.join(runtimeDir, "pending"),
    brokersDir: path.join(runtimeDir, "brokers"),
    authRouterSocket: path.join(runtimeDir, "auth-router.sock"),
    authRouterPidFile: path.join(runtimeDir, "auth-router.pid"),
    envoyConfigFile: path.join(runtimeDir, "envoy.yaml"),
  };
}

export function replaceNetwork(
  dockerArgs: string[],
  newNetwork: string,
): string[] {
  const args = [...dockerArgs];
  const idx = args.indexOf("--network");
  if (idx !== -1 && idx + 1 < args.length) {
    args[idx + 1] = newNetwork;
  } else {
    args.push("--network", newNetwork);
  }
  return args;
}

export function parseDindContainerName(
  envVars: Readonly<Record<string, string>>,
): string | null {
  const explicitName = envVars["NAS_DIND_CONTAINER_NAME"];
  if (explicitName && explicitName.trim() !== "") {
    return explicitName;
  }
  const dockerHost = envVars["DOCKER_HOST"];
  if (!dockerHost) return null;
  const match = dockerHost.match(/^tcp:\/\/([^:]+):\d+$/);
  return match ? match[1] : null;
}
