/**
 * NetworkRuntimeService — Effect-based abstraction over network runtime
 * directory management (GC stale sessions, copy mitmproxy addon, write review rules).
 *
 * Live implementation delegates to FsService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type { CredentialRule } from "../../config/types.ts";
import { resolveAsset } from "../../lib/asset.ts";
import type { ResolvedCredential } from "../../network/protocol.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { FsService } from "../../services/fs.ts";
import { ProcessService } from "../../services/process.ts";

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
    readonly resolveCredentials: (
      credentials: CredentialRule[],
    ) => Effect.Effect<ResolvedCredential[]>;
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
      ensureRuntimeDirs: (paths) =>
        Effect.gen(function* () {
          yield* fs.mkdir(paths.runtimeDir, { recursive: true, mode: 0o755 });
          yield* fs.mkdir(paths.sessionsDir, { recursive: true, mode: 0o755 });
          yield* fs.mkdir(paths.pendingDir, { recursive: true, mode: 0o755 });
          yield* fs.mkdir(paths.brokersDir, { recursive: true, mode: 0o755 });
          yield* fs.mkdir(paths.caCertDir, { recursive: true, mode: 0o755 });
          yield* fs.mkdir(paths.reviewRulesDir, {
            recursive: true,
            mode: 0o755,
          });
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

      resolveCredentials: (credentials) =>
        Effect.gen(function* () {
          const resolved: ResolvedCredential[] = [];
          for (const [i, cred] of credentials.entries()) {
            let value: string;
            // Null values are caught during config validation (validateCredentials);
            // by the time we reach here the val field is a valid string.
            if ("val" in cred.value) {
              value = cred.value.val;
            } else {
              const raw = yield* proc.exec(["sh", "-c", cred.value.valCmd]);
              // Take the first line only: trim() removes leading/trailing
              // whitespace (including newlines), then we take the first element
              // after splitting on newlines to discard any extra output lines.
              const output = raw.trim().split(/\r?\n/)[0];
              if (!output) {
                throw new Error(
                  `network.credentials[${i}].valCmd returned empty output`,
                );
              }
              value = output;
            }
            resolved.push({
              host: cred.host,
              pathPrefix: cred.pathPrefix,
              method: cred.method,
              header: cred.header.trim(),
              value,
            });
          }
          return resolved;
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
  readonly resolveCredentials?: (
    credentials: CredentialRule[],
  ) => Effect.Effect<ResolvedCredential[]>;
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
      resolveCredentials:
        overrides.resolveCredentials ?? (() => Effect.succeed([])),
    }),
  );
}
