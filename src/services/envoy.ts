/**
 * EnvoyService — Effect-based abstraction over shared Envoy container
 * and session network lifecycle.
 *
 * Live implementation delegates to DockerService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import {
  NAS_KIND_ENVOY,
  NAS_KIND_LABEL,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../docker/nas_resources.ts";
import { logInfo } from "../log.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import { DockerService } from "./docker.ts";

// ---------------------------------------------------------------------------
// EnvoyService-local plan interfaces (avoids service → stage dependency)
// ---------------------------------------------------------------------------

export interface EnsureEnvoyPlan {
  readonly envoyContainerName: string;
  readonly envoyImage: string;
  readonly runtimePaths: NetworkRuntimePaths;
  readonly envoyReadyTimeoutMs: number;
}

export interface SessionNetworkPlan {
  readonly sessionNetworkName: string;
  readonly envoyContainerName: string;
  readonly envoyAlias: string;
  readonly dindContainerName: string | null;
}

// ---------------------------------------------------------------------------
// EnvoyService tag
// ---------------------------------------------------------------------------

export class EnvoyService extends Context.Tag("nas/EnvoyService")<
  EnvoyService,
  {
    readonly ensureSharedEnvoy: (
      plan: EnsureEnvoyPlan,
    ) => Effect.Effect<void, unknown>;
    readonly createSessionNetwork: (
      plan: SessionNetworkPlan,
    ) => Effect.Effect<() => Effect.Effect<void>>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const EnvoyServiceLive: Layer.Layer<EnvoyService, never, DockerService> =
  Layer.effect(
    EnvoyService,
    Effect.gen(function* () {
      const docker = yield* DockerService;

      return EnvoyService.of({
        ensureSharedEnvoy: (plan) =>
          Effect.gen(function* () {
            const running = yield* docker.isRunning(plan.envoyContainerName);
            if (running) return;

            const exists = yield* docker.containerExists(
              plan.envoyContainerName,
            );
            if (exists) {
              yield* docker
                .rm(plan.envoyContainerName)
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.sync(() =>
                      logInfo(
                        `[nas] Proxy: failed to remove stale envoy container: ${e}`,
                      ),
                    ),
                  ),
                );
            }

            yield* docker.runDetached({
              name: plan.envoyContainerName,
              image: plan.envoyImage,
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
                [NAS_KIND_LABEL]: NAS_KIND_ENVOY,
              },
              command: ["-c", "/nas-network/envoy.yaml", "--log-level", "info"],
            });

            // Wait for envoy readiness
            const started = Date.now();
            while (Date.now() - started < plan.envoyReadyTimeoutMs) {
              const isRunning = yield* docker.isRunning(
                plan.envoyContainerName,
              );
              if (isRunning) return;
              yield* Effect.sleep("200 millis");
            }
            const logs = yield* docker.logs(plan.envoyContainerName);
            yield* Effect.fail(
              new Error(`Envoy sidecar failed to start:\n${logs}`),
            );
          }),

        createSessionNetwork: (plan) =>
          Effect.gen(function* () {
            let envoyConnected = false;
            let dindConnected = false;

            yield* docker.networkCreate(plan.sessionNetworkName, {
              internal: true,
              labels: {
                [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
                [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
              },
            });

            yield* docker.networkConnect(
              plan.sessionNetworkName,
              plan.envoyContainerName,
              { aliases: [plan.envoyAlias] },
            );
            envoyConnected = true;

            if (plan.dindContainerName) {
              yield* docker.networkConnect(
                plan.sessionNetworkName,
                plan.dindContainerName,
              );
              dindConnected = true;
            }

            const teardown = (): Effect.Effect<void> =>
              Effect.gen(function* () {
                if (dindConnected && plan.dindContainerName) {
                  yield* docker
                    .networkDisconnect(
                      plan.sessionNetworkName,
                      plan.dindContainerName,
                    )
                    .pipe(
                      Effect.catchAll((e) =>
                        Effect.sync(() =>
                          logInfo(
                            `[nas] Proxy teardown: failed to disconnect dind from network: ${e}`,
                          ),
                        ),
                      ),
                    );
                }
                if (envoyConnected) {
                  yield* docker
                    .networkDisconnect(
                      plan.sessionNetworkName,
                      plan.envoyContainerName,
                    )
                    .pipe(
                      Effect.catchAll((e) =>
                        Effect.sync(() =>
                          logInfo(
                            `[nas] Proxy teardown: failed to disconnect envoy from network: ${e}`,
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

            return teardown;
          }),
      });
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface EnvoyServiceFakeConfig {
  readonly ensureSharedEnvoy?: (
    plan: EnsureEnvoyPlan,
  ) => Effect.Effect<void, unknown>;
  readonly createSessionNetwork?: (
    plan: SessionNetworkPlan,
  ) => Effect.Effect<() => Effect.Effect<void>>;
}

export function makeEnvoyServiceFake(
  overrides: EnvoyServiceFakeConfig = {},
): Layer.Layer<EnvoyService> {
  return Layer.succeed(
    EnvoyService,
    EnvoyService.of({
      ensureSharedEnvoy: overrides.ensureSharedEnvoy ?? (() => Effect.void),
      createSessionNetwork:
        overrides.createSessionNetwork ??
        (() => Effect.succeed(() => Effect.void)),
    }),
  );
}
