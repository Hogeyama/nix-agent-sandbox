/**
 * AuthRouterService — Effect-based abstraction over the auth-router daemon lifecycle.
 *
 * Encapsulates daemon startup and teardown (abort).
 * Live implementation delegates to ensureAuthRouterDaemon from
 * src/network/envoy_auth_router.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { ensureAuthRouterDaemon } from "../network/envoy_auth_router.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export interface AuthRouterHandle {
  readonly abort: () => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// AuthRouterService tag
// ---------------------------------------------------------------------------

export class AuthRouterService extends Context.Tag("nas/AuthRouterService")<
  AuthRouterService,
  {
    readonly ensureDaemon: (
      runtimePaths: NetworkRuntimePaths,
    ) => Effect.Effect<AuthRouterHandle>;
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
        }).pipe(
          Effect.map(
            (controller): AuthRouterHandle => ({
              abort: () =>
                Effect.sync(() => {
                  if (controller) {
                    controller.abort();
                  }
                }),
            }),
          ),
          Effect.orDie,
        ),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface AuthRouterServiceFakeConfig {
  readonly ensureDaemon?: (
    runtimePaths: NetworkRuntimePaths,
  ) => Effect.Effect<AuthRouterHandle>;
}

export function makeAuthRouterServiceFake(
  overrides: AuthRouterServiceFakeConfig = {},
): Layer.Layer<AuthRouterService> {
  return Layer.succeed(
    AuthRouterService,
    AuthRouterService.of({
      ensureDaemon:
        overrides.ensureDaemon ??
        (() => Effect.succeed({ abort: () => Effect.void })),
    }),
  );
}
