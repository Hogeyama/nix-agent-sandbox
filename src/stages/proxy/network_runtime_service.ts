/**
 * NetworkRuntimeService — Effect-based abstraction over network runtime
 * directory management (GC stale sessions, copy mitmproxy addon, write review rules).
 *
 * Live implementation delegates to FsService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { resolveAsset } from "../../lib/asset.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { FsService } from "../../services/fs.ts";

// ---------------------------------------------------------------------------
// NetworkRuntimeService tag
// ---------------------------------------------------------------------------

export class NetworkRuntimeService extends Context.Tag(
  "nas/NetworkRuntimeService",
)<
  NetworkRuntimeService,
  {
    readonly ensureRuntimeDirs: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
    readonly gcStaleRuntime: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
    readonly copyAddonScript: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
    readonly writeReviewRules: (
      paths: NetworkRuntimePaths,
      sessionId: string,
      rules: import("../../config/types.ts").ReviewRule[],
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const NetworkRuntimeServiceLive: Layer.Layer<
  NetworkRuntimeService,
  never,
  FsService
> = Layer.effect(
  NetworkRuntimeService,
  Effect.gen(function* () {
    const fs = yield* FsService;

    return NetworkRuntimeService.of({
      ensureRuntimeDirs: (paths) =>
        Effect.gen(function* () {
          yield* fs.mkdir(paths.runtimeDir, { recursive: true, mode: 0o755 });
          yield* fs.mkdir(paths.sessionsDir, { recursive: true });
          yield* fs.mkdir(paths.pendingDir, { recursive: true });
          yield* fs.mkdir(paths.brokersDir, { recursive: true });
          yield* fs.mkdir(paths.caCertDir, { recursive: true });
          yield* fs.mkdir(paths.reviewRulesDir, { recursive: true });
        }),

      gcStaleRuntime: (_paths) => Effect.void,

      copyAddonScript: (paths) =>
        Effect.gen(function* () {
          const addonSource = resolveAsset(
            "docker/mitmproxy/nas_addon.py",
            import.meta.url,
            "../../docker/mitmproxy/nas_addon.py",
          );
          const source = yield* fs.readFile(addonSource);
          yield* fs.writeFile(paths.addonScriptPath, source, { mode: 0o644 });
        }),

      writeReviewRules: (paths, sessionId, rules) =>
        Effect.gen(function* () {
          const rulesPath = `${paths.reviewRulesDir}/${sessionId}.json`;
          yield* fs.writeFile(rulesPath, JSON.stringify(rules), {
            mode: 0o644,
          });
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface NetworkRuntimeServiceFakeConfig {
  readonly ensureRuntimeDirs?: (
    paths: NetworkRuntimePaths,
  ) => Effect.Effect<void>;
  readonly gcStaleRuntime?: (paths: NetworkRuntimePaths) => Effect.Effect<void>;
  readonly copyAddonScript?: (
    paths: NetworkRuntimePaths,
  ) => Effect.Effect<void>;
  readonly writeReviewRules?: (
    paths: NetworkRuntimePaths,
    sessionId: string,
    rules: import("../../config/types.ts").ReviewRule[],
  ) => Effect.Effect<void>;
}

export function makeNetworkRuntimeServiceFake(
  overrides: NetworkRuntimeServiceFakeConfig = {},
): Layer.Layer<NetworkRuntimeService> {
  return Layer.succeed(
    NetworkRuntimeService,
    NetworkRuntimeService.of({
      ensureRuntimeDirs: overrides.ensureRuntimeDirs ?? (() => Effect.void),
      gcStaleRuntime: overrides.gcStaleRuntime ?? (() => Effect.void),
      copyAddonScript: overrides.copyAddonScript ?? (() => Effect.void),
      writeReviewRules: overrides.writeReviewRules ?? (() => Effect.void),
    }),
  );
}
