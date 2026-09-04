/**
 * DindService — Effect-based abstraction over DinD sidecar lifecycle.
 *
 * Live implementation delegates to ensureDindSidecar / teardownDindSidecar
 * from src/docker/dind.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { ensureDindSidecar, teardownDindSidecar } from "../../docker/dind.ts";
import type { ExtraHost } from "../../pipeline/state.ts";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface DindSidecarOpts {
  readonly containerName: string;
  readonly sharedTmpVolume: string;
  /** Session network the sidecar attaches to (replaces the old private net). */
  readonly networkName: string;
  /** dockerd HTTP(S)_PROXY endpoint (token-bearing proxy URL). */
  readonly proxyEndpoint: string;
  /**
   * Host-to-IP mappings the sidecar's /etc/hosts must carry (e.g. the proxy
   * alias). The agent joins the sidecar's network namespace and shares its
   * /etc/hosts, so entries the agent needs must be added here instead of via
   * the agent container's own --add-host.
   */
  readonly extraHosts: readonly ExtraHost[];
  readonly shared: boolean;
  readonly disableCache: boolean;
  readonly readinessTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// DindService tag
// ---------------------------------------------------------------------------

export class DindService extends Context.Tag("nas/DindService")<
  DindService,
  {
    readonly ensureSidecar: (opts: DindSidecarOpts) => Effect.Effect<void>;
    readonly teardownSidecar: (opts: DindTeardownOpts) => Effect.Effect<void>;
  }
>() {}

export interface DindTeardownOpts {
  readonly containerName: string;
  readonly sharedTmpVolume: string;
  /** Session network the sidecar was attached to (shared teardown detaches). */
  readonly networkName: string;
  readonly shared: boolean;
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
            sharedTmpVolume: opts.sharedTmpVolume,
            sessionNetworkName: opts.networkName,
            proxyEndpoint: opts.proxyEndpoint,
            extraHosts: opts.extraHosts,
            shared: opts.shared,
            disableCache: opts.disableCache,
            readinessTimeoutMs: opts.readinessTimeoutMs,
          }),
        catch: (e) =>
          new Error(
            `ensureDindSidecar failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.asVoid, Effect.orDie),

    teardownSidecar: (opts) =>
      Effect.tryPromise({
        try: () =>
          teardownDindSidecar({
            containerName: opts.containerName,
            sharedTmpVolume: opts.sharedTmpVolume,
            sessionNetworkName: opts.networkName,
            shared: opts.shared,
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
  readonly ensureSidecar?: (opts: DindSidecarOpts) => Effect.Effect<void>;
  readonly teardownSidecar?: (opts: DindTeardownOpts) => Effect.Effect<void>;
}

export function makeDindServiceFake(
  overrides: DindServiceFakeConfig = {},
): Layer.Layer<DindService> {
  return Layer.succeed(
    DindService,
    DindService.of({
      ensureSidecar: overrides.ensureSidecar ?? (() => Effect.void),
      teardownSidecar: overrides.teardownSidecar ?? (() => Effect.void),
    }),
  );
}
