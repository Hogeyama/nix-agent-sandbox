/**
 * DindService — Effect-based abstraction over DinD sidecar lifecycle.
 *
 * Live implementation delegates to ensureDindSidecar / teardownDindSidecar
 * from src/docker/dind.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type {
  DindReadinessMonitor,
  DindSidecarHandle,
} from "../../docker/dind.ts";
import { ensureDindSidecar, teardownDindSidecar } from "../../docker/dind.ts";
import type { ExtraHost } from "../../pipeline/state.ts";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface DindSidecarOpts {
  readonly containerName: string;
  readonly dindDataVolume: string;
  readonly sharedTmpVolume: string;
  readonly registryMirrorName: string;
  readonly registryCacheVolume: string;
  /** Session network the sidecar attaches to (replaces the old private net). */
  readonly networkName: string;
  /** dockerd HTTP(S)_PROXY endpoint (token-bearing proxy URL). */
  readonly proxyEndpoint: string;
  /** Path to the session proxy's public CA certificate. */
  readonly caCertPath: string;
  /**
   * Host-to-IP mappings the sidecar's /etc/hosts must carry (e.g. the proxy
   * alias). The agent joins the sidecar's network namespace and shares its
   * /etc/hosts, so entries the agent needs must be added here instead of via
   * the agent container's own --add-host.
   */
  readonly extraHosts: readonly ExtraHost[];
  readonly disablePullCache: boolean;
  readonly readinessTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// DindService tag
// ---------------------------------------------------------------------------

export class DindService extends Context.Tag("nas/DindService")<
  DindService,
  {
    readonly ensureSidecar: (
      opts: DindSidecarOpts,
    ) => Effect.Effect<DindSidecarHandle>;
    readonly teardownSidecar: (opts: DindTeardownOpts) => Effect.Effect<void>;
  }
>() {}

export interface DindTeardownOpts {
  readonly containerName: string;
  readonly dindDataVolume: string;
  readonly sharedTmpVolume: string;
  readonly registryMirrorName: string | null;
  readonly readinessMonitor: DindReadinessMonitor;
  /**
   * Name of the agent container that joined this sidecar's network
   * namespace (`--network container:<containerName>`). Teardown checks
   * whether it is still running and skips removal while it is, since
   * removing the sidecar would strip the agent's namespace owner.
   */
  readonly joinerContainerName: string;
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const DindServiceLive: Layer.Layer<DindService> = Layer.succeed(
  DindService,
  DindService.of({
    ensureSidecar: (opts) =>
      Effect.tryPromise({
        try: () =>
          ensureDindSidecar({
            containerName: opts.containerName,
            dindDataVolume: opts.dindDataVolume,
            sharedTmpVolume: opts.sharedTmpVolume,
            registryMirrorName: opts.registryMirrorName,
            registryCacheVolume: opts.registryCacheVolume,
            sessionNetworkName: opts.networkName,
            proxyEndpoint: opts.proxyEndpoint,
            caCertPath: opts.caCertPath,
            extraHosts: opts.extraHosts,
            disablePullCache: opts.disablePullCache,
            readinessTimeoutMs: opts.readinessTimeoutMs,
          }),
        catch: (e) =>
          new Error(
            `ensureDindSidecar failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    teardownSidecar: (opts) =>
      Effect.tryPromise({
        try: () =>
          teardownDindSidecar({
            containerName: opts.containerName,
            dindDataVolume: opts.dindDataVolume,
            sharedTmpVolume: opts.sharedTmpVolume,
            registryMirrorName: opts.registryMirrorName,
            readinessMonitor: opts.readinessMonitor,
            joinerContainerName: opts.joinerContainerName,
          }),
        catch: (e) =>
          new Error(
            `teardownDindSidecar failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface DindServiceFakeConfig {
  readonly ensureSidecar?: (
    opts: DindSidecarOpts,
  ) => Effect.Effect<DindSidecarHandle>;
  readonly teardownSidecar?: (opts: DindTeardownOpts) => Effect.Effect<void>;
}

export function makeDindServiceFake(
  overrides: DindServiceFakeConfig = {},
): Layer.Layer<DindService> {
  return Layer.succeed(
    DindService,
    DindService.of({
      ensureSidecar:
        overrides.ensureSidecar ??
        (() =>
          Effect.succeed({
            registryMirrorName: null,
            readinessMonitor: {
              finished: Promise.resolve(),
              cancel: () => {},
            },
          })),
      teardownSidecar: overrides.teardownSidecar ?? (() => Effect.void),
    }),
  );
}
