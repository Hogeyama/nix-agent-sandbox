/**
 * OtlpReceiverService — Effect-based abstraction over the per-session OTLP/HTTP
 * receiver lifecycle.
 *
 * Live implementation delegates to startOtlpReceiver from
 * src/history/receiver.ts. Fake implementation provides a configurable
 * no-op listener for tests and observation of the start arguments.
 */

import { Context, Effect, Layer } from "effect";
import {
  type OtlpReceiverHandle,
  type StartOtlpReceiverOptions,
  startOtlpReceiver,
} from "../../history/receiver.ts";

// ---------------------------------------------------------------------------
// OtlpReceiverService tag
// ---------------------------------------------------------------------------

export class OtlpReceiverService extends Context.Tag("nas/OtlpReceiverService")<
  OtlpReceiverService,
  {
    readonly start: (
      options: StartOtlpReceiverOptions,
    ) => Effect.Effect<OtlpReceiverHandle, Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const OtlpReceiverServiceLive: Layer.Layer<OtlpReceiverService> =
  Layer.succeed(
    OtlpReceiverService,
    OtlpReceiverService.of({
      start: (options) =>
        Effect.tryPromise({
          try: () => startOtlpReceiver(options),
          catch: (e) =>
            new Error(
              `OtlpReceiverService start failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface FakeOtlpReceiverServiceArgs {
  /** Optionally override the port reported to callers. Default 0. */
  readonly port?: number;
  /** Capture the options the caller passed to start(). */
  readonly onStart?: (options: StartOtlpReceiverOptions) => void;
}

export function makeOtlpReceiverServiceFake(
  args: FakeOtlpReceiverServiceArgs = {},
): Layer.Layer<OtlpReceiverService> {
  return Layer.succeed(
    OtlpReceiverService,
    OtlpReceiverService.of({
      start: (options) =>
        Effect.sync(() => {
          args.onStart?.(options);
          return {
            port: args.port ?? 0,
            close: async () => {},
          };
        }),
    }),
  );
}
