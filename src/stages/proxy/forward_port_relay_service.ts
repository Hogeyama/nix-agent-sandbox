/**
 * ForwardPortRelayService — Effect-based abstraction over per-session
 * forward-port UDS relay lifecycle.
 *
 * Live implementation delegates to startSessionForwardPortRelays from
 * src/network/forward_port_relay.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { startSessionForwardPortRelays } from "../../network/forward_port_relay.ts";

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export interface ForwardPortRelayHandle {
  readonly socketPaths: ReadonlyMap<number, string>;
  readonly close: () => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EnsureForwardPortRelaysOptions {
  readonly runtimeDir: string;
  readonly sessionId: string;
  readonly ports: ReadonlyArray<number>;
}

// ---------------------------------------------------------------------------
// ForwardPortRelayService tag
// ---------------------------------------------------------------------------

export class ForwardPortRelayService extends Context.Tag(
  "nas/ForwardPortRelayService",
)<
  ForwardPortRelayService,
  {
    readonly ensureRelays: (
      opts: EnsureForwardPortRelaysOptions,
    ) => Effect.Effect<ForwardPortRelayHandle>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const ForwardPortRelayServiceLive: Layer.Layer<ForwardPortRelayService> =
  Layer.succeed(
    ForwardPortRelayService,
    ForwardPortRelayService.of({
      ensureRelays: (opts) =>
        Effect.tryPromise({
          try: () =>
            startSessionForwardPortRelays({
              runtimeDir: opts.runtimeDir,
              sessionId: opts.sessionId,
              ports: opts.ports,
            }),
          catch: (e) =>
            new Error(
              `ForwardPortRelayService ensureRelays failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
        }).pipe(
          Effect.map(
            (prodHandle): ForwardPortRelayHandle => ({
              socketPaths: prodHandle.socketPaths,
              close: () =>
                Effect.tryPromise({
                  try: () => prodHandle.close(),
                  catch: (e) =>
                    new Error(
                      `ForwardPortRelayService close failed: ${
                        e instanceof Error ? e.message : String(e)
                      }`,
                    ),
                }).pipe(Effect.orDie),
            }),
          ),
          Effect.orDie,
        ),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface ForwardPortRelayServiceFakeConfig {
  readonly ensureRelays?: (
    opts: EnsureForwardPortRelaysOptions,
  ) => Effect.Effect<ForwardPortRelayHandle>;
}

export function makeForwardPortRelayServiceFake(
  overrides: ForwardPortRelayServiceFakeConfig = {},
): Layer.Layer<ForwardPortRelayService> {
  return Layer.succeed(
    ForwardPortRelayService,
    ForwardPortRelayService.of({
      ensureRelays:
        overrides.ensureRelays ??
        (() =>
          Effect.succeed({
            socketPaths: new Map<number, string>(),
            close: () => Effect.void,
          })),
    }),
  );
}
