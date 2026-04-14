/**
 * NetworkRuntimeService — Effect-based abstraction over network runtime
 * directory management (GC stale sessions, render envoy config).
 *
 * Live implementation delegates to FsService + ProcessService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { resolveAsset } from "../lib/asset.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import { FsService } from "./fs.ts";
import { ProcessService } from "./process.ts";

// ---------------------------------------------------------------------------
// NetworkRuntimeService tag
// ---------------------------------------------------------------------------

export class NetworkRuntimeService extends Context.Tag(
  "nas/NetworkRuntimeService",
)<
  NetworkRuntimeService,
  {
    readonly gcStaleRuntime: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
    readonly renderEnvoyConfig: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const NetworkRuntimeServiceLive: Layer.Layer<
  NetworkRuntimeService,
  never,
  FsService | ProcessService
> = Layer.effect(
  NetworkRuntimeService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;

    return NetworkRuntimeService.of({
      gcStaleRuntime: (paths) =>
        Effect.gen(function* () {
          const pidFileExists = yield* fs.exists(paths.authRouterPidFile);
          if (!pidFileExists) return;

          const pidStr = yield* fs.readFile(paths.authRouterPidFile);
          const pid = Number.parseInt(pidStr.trim(), 10);
          if (Number.isNaN(pid)) {
            yield* fs.rm(paths.authRouterPidFile, { force: true });
            yield* fs
              .rm(paths.authRouterSocket, { force: true })
              .pipe(Effect.catchAll(() => Effect.void));
            return;
          }

          const alive = yield* proc.exec(["kill", "-0", pid.toString()]).pipe(
            Effect.as(true),
            Effect.catchAll(() => Effect.succeed(false)),
          );

          if (!alive) {
            yield* fs
              .rm(paths.authRouterSocket, { force: true })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* fs
              .rm(paths.authRouterPidFile, { force: true })
              .pipe(Effect.catchAll(() => Effect.void));
          }
        }),

      renderEnvoyConfig: (paths) =>
        Effect.gen(function* () {
          const envoyTemplatePath = resolveAsset(
            "docker/envoy/envoy.template.yaml",
            import.meta.url,
            "../docker/envoy/envoy.template.yaml",
          );
          const source = yield* fs.readFile(envoyTemplatePath);
          yield* fs.writeFile(paths.envoyConfigFile, source, { mode: 0o644 });
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface NetworkRuntimeServiceFakeConfig {
  readonly gcStaleRuntime?: (paths: NetworkRuntimePaths) => Effect.Effect<void>;
  readonly renderEnvoyConfig?: (
    paths: NetworkRuntimePaths,
  ) => Effect.Effect<void>;
}

export function makeNetworkRuntimeServiceFake(
  overrides: NetworkRuntimeServiceFakeConfig = {},
): Layer.Layer<NetworkRuntimeService> {
  return Layer.succeed(
    NetworkRuntimeService,
    NetworkRuntimeService.of({
      gcStaleRuntime: overrides.gcStaleRuntime ?? (() => Effect.void),
      renderEnvoyConfig: overrides.renderEnvoyConfig ?? (() => Effect.void),
    }),
  );
}
