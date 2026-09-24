/**
 * ProxyService — Effect-based abstraction over shared proxy container
 * and session network lifecycle.
 *
 * Live implementation delegates to DockerService.
 * Fake implementation provides configurable stubs for testing.
 */

import { createHash } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import {
  NAS_ADDON_HASH_LABEL,
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_PROXY_COMMAND_HASH_LABEL,
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
  readonly addonHash: string;
}

export interface SessionNetworkPlan {
  readonly sessionNetworkName: string;
  readonly proxyContainerName: string;
  readonly proxyAlias: string;
}

/**
 * The stock mitmproxy entrypoint rewrites the `mitmproxy` account to the
 * uid/gid that owns the mounted cert store (`usermod -u <uid> -g <gid>`).
 * `usermod -g` requires the gid to resolve to a group in /etc/group, so a
 * host whose primary gid is absent from the image (e.g. a CI runner user
 * with gid 1001) kills the container with `usermod: group '<gid>' does not
 * exist` before mitmdump starts. Create the group up front, then defer to
 * the stock entrypoint for the usermod + gosu drop.
 */
const PROXY_ENTRYPOINT_WRAPPER = [
  "f=/home/mitmproxy/.mitmproxy/mitmproxy-ca.pem",
  '[ -f "$f" ] || f=/home/mitmproxy/.mitmproxy',
  'g=$(stat -c %g "$f")',
  'getent group "$g" >/dev/null 2>&1 || groupadd -o -g "$g" nas-host-group',
  'exec docker-entrypoint.sh "$@"',
].join("; ");

/**
 * The mitmdump invocation. Upstream TLS certificates are verified with
 * mitmproxy's defaults: the image's certifi bundle as trust store, and the
 * connection's SNI as the name the certificate must match. The agent's TLS
 * ends at this proxy, so this check is the only one on the proxy→upstream
 * leg, where the injected credentials travel.
 */
const PROXY_MITMDUMP_COMMAND: readonly string[] = [
  "mitmdump",
  "--mode",
  "regular@8080",
  "--set",
  "connection_strategy=lazy",
  "--set",
  "rawtcp=false",
  "--set",
  "websocket=true",
  "--set",
  "confdir=/nas-network/mitmproxy-ca",
  "-s",
  "/nas-network/nas_addon.py",
];

/**
 * The addon hash only tracks the addon script and its vendored files. A proxy
 * left running by an older nas with other flags (such as the former
 * `--ssl-insecure`) must be recreated too, so the command gets its own label.
 */
export const PROXY_COMMAND_HASH = createHash("sha256")
  .update(JSON.stringify([PROXY_ENTRYPOINT_WRAPPER, ...PROXY_MITMDUMP_COMMAND]))
  .digest("hex");

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
            if (running) {
              const details = yield* docker
                .inspect(plan.proxyContainerName)
                .pipe(Effect.orDie);
              const existingHash = details.labels[NAS_ADDON_HASH_LABEL] ?? null;
              const existingCommandHash =
                details.labels[NAS_PROXY_COMMAND_HASH_LABEL] ?? null;
              if (
                existingHash === plan.addonHash &&
                existingCommandHash === PROXY_COMMAND_HASH
              ) {
                return;
              }
              logInfo(
                existingHash === plan.addonHash
                  ? `[nas] Proxy: proxy command changed, recreating proxy container`
                  : `[nas] Proxy: addon script changed, recreating proxy container`,
              );
              yield* docker
                .stop(plan.proxyContainerName, { timeoutSeconds: 5 })
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.sync(() =>
                      logInfo(
                        `[nas] Proxy: failed to stop outdated proxy container: ${e}`,
                      ),
                    ),
                  ),
                );
              yield* docker
                .rm(plan.proxyContainerName)
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.sync(() =>
                      logInfo(
                        `[nas] Proxy: failed to remove outdated proxy container: ${e}`,
                      ),
                    ),
                  ),
                );
            }

            yield* docker.ensureImage(plan.proxyImage).pipe(Effect.orDie);

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
                  {
                    source: plan.runtimePaths.caCertDir,
                    target: "/home/mitmproxy/.mitmproxy",
                    mode: "rw",
                  },
                ],
                labels: {
                  [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
                  [NAS_KIND_LABEL]: NAS_KIND_PROXY,
                  [NAS_ADDON_HASH_LABEL]: plan.addonHash,
                  [NAS_PROXY_COMMAND_HASH_LABEL]: PROXY_COMMAND_HASH,
                },
                entrypoint: "bash",
                command: [
                  "-c",
                  PROXY_ENTRYPOINT_WRAPPER,
                  "nas-proxy-entrypoint",
                  ...PROXY_MITMDUMP_COMMAND,
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
