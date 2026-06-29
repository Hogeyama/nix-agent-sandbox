/**
 * ProxyService — Effect-based abstraction over shared proxy container
 * and session network lifecycle.
 *
 * Live implementation delegates to DockerService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import {
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../../docker/nas_resources.ts";
import { logInfo } from "../../log.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { DockerService } from "../../services/docker.ts";

// ---------------------------------------------------------------------------
// ProxyService-local plan interfaces (avoids service → stage dependency)
// ---------------------------------------------------------------------------

export interface EnsureProxyPlan {
  readonly proxyContainerName: string;
  readonly proxyImage: string;
  readonly runtimePaths: NetworkRuntimePaths;
  readonly proxyReadyTimeoutMs: number;
}

export interface SessionNetworkPlan {
  readonly sessionNetworkName: string;
  readonly proxyContainerName: string;
  readonly proxyAlias: string;
}

// ---------------------------------------------------------------------------
// ProxyService tag
// ---------------------------------------------------------------------------

export class ProxyService extends Context.Tag("nas/ProxyService")<
  ProxyService,
  {
    readonly ensureSharedProxy: (
      plan: EnsureProxyPlan,
    ) => Effect.Effect<void, unknown>;
    readonly createSessionNetwork: (plan: SessionNetworkPlan) => Effect.Effect<{
      teardown: () => Effect.Effect<void>;
      proxyIp: string | null;
    }>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const ProxyServiceLive: Layer.Layer<ProxyService, never, DockerService> =
  Layer.effect(
    ProxyService,
    Effect.gen(function* () {
      const docker = yield* DockerService;

      return ProxyService.of({
        ensureSharedProxy: (plan) =>
          Effect.gen(function* () {
            const running = yield* docker
              .isRunning(plan.proxyContainerName)
              .pipe(Effect.orDie);
            if (running) return;

            const exists = yield* docker
              .containerExists(plan.proxyContainerName)
              .pipe(Effect.orDie);
            if (exists) {
              yield* docker
                .rm(plan.proxyContainerName)
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.sync(() =>
                      logInfo(
                        `[nas] Proxy: failed to remove stale proxy container: ${e}`,
                      ),
                    ),
                  ),
                );
            }

            yield* docker
              .runDetached({
                name: plan.proxyContainerName,
                image: plan.proxyImage,
                args: ["--add-host=host.docker.internal:host-gateway"],
                envVars: {},
                mounts: [
                  {
                    source: plan.runtimePaths.runtimeDir,
                    target: "/nas-network",
                    mode: "rw",
                  },
                ],
                labels: {
                  [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
                  [NAS_KIND_LABEL]: NAS_KIND_PROXY,
                },
                command: [
                  "mitmdump",
                  "--mode",
                  "regular@8080",
                  "--set",
                  "connection_strategy=lazy",
                  "--set",
                  "confdir=/nas-network/mitmproxy-ca",
                  "--ssl-insecure",
                  "-s",
                  "/nas-network/nas_addon.py",
                ],
              })
              .pipe(Effect.orDie);

            // Wait for proxy readiness
            const started = Date.now();
            while (Date.now() - started < plan.proxyReadyTimeoutMs) {
              const isRunning = yield* docker
                .isRunning(plan.proxyContainerName)
                .pipe(Effect.orDie);
              if (isRunning) return;
              yield* Effect.sleep("200 millis");
            }
            const logs = yield* docker
              .logs(plan.proxyContainerName)
              .pipe(Effect.orDie);
            yield* Effect.fail(
              new Error(`Proxy container failed to start:\n${logs}`),
            );
          }),

        createSessionNetwork: (plan) =>
          Effect.gen(function* () {
            let proxyConnected = false;

            yield* docker
              .networkCreate(plan.sessionNetworkName, {
                internal: true,
                labels: {
                  [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
                  [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
                },
              })
              .pipe(Effect.orDie);

            yield* docker
              .networkConnect(
                plan.sessionNetworkName,
                plan.proxyContainerName,
                { aliases: [plan.proxyAlias] },
              )
              .pipe(Effect.orDie);
            proxyConnected = true;

            const proxyIp = yield* docker
              .containerIpOnNetwork(
                plan.proxyContainerName,
                plan.sessionNetworkName,
              )
              .pipe(Effect.orDie);

            const teardown = (): Effect.Effect<void> =>
              Effect.gen(function* () {
                if (proxyConnected) {
                  yield* docker
                    .networkDisconnect(
                      plan.sessionNetworkName,
                      plan.proxyContainerName,
                    )
                    .pipe(
                      Effect.catchAll((e) =>
                        Effect.sync(() =>
                          logInfo(
                            `[nas] Proxy teardown: failed to disconnect proxy from network: ${e}`,
                          ),
                        ),
                      ),
                    );
                }
                yield* docker
                  .networkRemove(plan.sessionNetworkName)
                  .pipe(
                    Effect.catchAll((e) =>
                      Effect.sync(() =>
                        logInfo(
                          `[nas] Proxy teardown: failed to remove network: ${e}`,
                        ),
                      ),
                    ),
                  );
              });

            return { teardown, proxyIp };
          }),
      });
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface ProxyServiceFakeConfig {
  readonly ensureSharedProxy?: (
    plan: EnsureProxyPlan,
  ) => Effect.Effect<void, unknown>;
  readonly createSessionNetwork?: (plan: SessionNetworkPlan) => Effect.Effect<{
    teardown: () => Effect.Effect<void>;
    proxyIp: string | null;
  }>;
}

export function makeProxyServiceFake(
  overrides: ProxyServiceFakeConfig = {},
): Layer.Layer<ProxyService> {
  return Layer.succeed(
    ProxyService,
    ProxyService.of({
      ensureSharedProxy: overrides.ensureSharedProxy ?? (() => Effect.void),
      createSessionNetwork:
        overrides.createSessionNetwork ??
        (() =>
          Effect.succeed({
            teardown: () => Effect.void,
            proxyIp: "172.18.0.2",
          })),
    }),
  );
}
