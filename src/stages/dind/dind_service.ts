/**
 * DindService — Effect-based abstraction over DinD sidecar lifecycle.
 *
 * Live implementation delegates to ensureDindSidecar / teardownDindSidecar
 * from src/docker/dind.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { ensureDindSidecar, teardownDindSidecar } from "../../docker/dind.ts";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface DindSidecarOpts {
  readonly containerName: string;
  readonly sharedTmpVolume: string;
  readonly networkName: string;
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
    readonly teardownSidecar: (opts: {
      containerName: string;
      networkName: string;
      sharedTmpVolume: string;
      shared: boolean;
    }) => Effect.Effect<void>;
  }
>() {}

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
            networkName: opts.networkName,
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
            networkName: opts.networkName,
            sharedTmpVolume: opts.sharedTmpVolume,
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
  readonly teardownSidecar?: (opts: {
    containerName: string;
    networkName: string;
    sharedTmpVolume: string;
    shared: boolean;
  }) => Effect.Effect<void>;
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
