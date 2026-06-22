/**
 * AuthRouterService — Effect-based abstraction over the auth-router daemon lifecycle.
 *
 * Encapsulates ensuring the shared auth-router daemon is running.
 * Live implementation delegates to ensureAuthRouterDaemon from
 * src/network/envoy_auth_router.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { ensureAuthRouterDaemon } from "../../network/envoy_auth_router.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";

// ---------------------------------------------------------------------------
// AuthRouterService tag
// ---------------------------------------------------------------------------

export class AuthRouterService extends Context.Tag("nas/AuthRouterService")<
  AuthRouterService,
  {
    readonly ensureDaemon: (
      runtimePaths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const AuthRouterServiceLive: Layer.Layer<AuthRouterService> =
  Layer.succeed(
    AuthRouterService,
    AuthRouterService.of({
      ensureDaemon: (runtimePaths) =>
        Effect.tryPromise({
          try: () => ensureAuthRouterDaemon(runtimePaths),
          catch: (e) =>
            new Error(
              `AuthRouterService ensureDaemon failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        }).pipe(Effect.asVoid, Effect.orDie),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface AuthRouterServiceFakeConfig {
  readonly ensureDaemon?: (
    runtimePaths: NetworkRuntimePaths,
  ) => Effect.Effect<void>;
}

export function makeAuthRouterServiceFake(
  overrides: AuthRouterServiceFakeConfig = {},
): Layer.Layer<AuthRouterService> {
  return Layer.succeed(
    AuthRouterService,
    AuthRouterService.of({
      ensureDaemon: overrides.ensureDaemon ?? (() => Effect.void),
    }),
  );
}
