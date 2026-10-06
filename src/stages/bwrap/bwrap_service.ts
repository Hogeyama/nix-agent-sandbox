/**
 * BwrapService — places the session's seccomp profile in the host-side
 * runtime dir, where `docker run` reads it, and removes it at session end.
 */

import * as path from "node:path";
import { Cause, Context, Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";

export interface BwrapWritePlan {
  /** Session directory: the unit this service creates and removes whole. */
  readonly sessionDir: string;
  /** The seccomp profile as JSON text. */
  readonly seccompProfile: string;
}

export interface BwrapHandle {
  /** Host path of the written profile. */
  readonly seccompProfilePath: string;
  readonly close: () => Effect.Effect<void>;
}

export class BwrapService extends Context.Tag("nas/BwrapService")<
  BwrapService,
  {
    readonly write: (plan: BwrapWritePlan) => Effect.Effect<BwrapHandle>;
  }
>() {}

export const BwrapServiceLive: Layer.Layer<BwrapService, never, FsService> =
  Layer.effect(
    BwrapService,
    Effect.gen(function* () {
      const fs = yield* FsService;

      // fs.rm dies on failure; catchAllCause sees the defect and logs it.
      const removeSessionDir = (sessionDir: string): Effect.Effect<void> =>
        fs
          .rm(sessionDir, { recursive: true, force: true })
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.logWarning(
                `BwrapService: failed to remove ${sessionDir}: ${Cause.pretty(cause)}`,
              ),
            ),
          );

      return BwrapService.of({
        write: (plan) => {
          const seccompProfilePath = path.join(plan.sessionDir, "seccomp.json");
          return Effect.gen(function* () {
            // Read by the Docker CLI on the host, never mounted into the
            // container, so both stay private to the user.
            yield* fs.mkdir(plan.sessionDir, { recursive: true, mode: 0o700 });
            yield* fs.writeFile(seccompProfilePath, plan.seccompProfile, {
              mode: 0o600,
            });
            return {
              seccompProfilePath,
              close: () => removeSessionDir(plan.sessionDir),
            };
          }).pipe(Effect.onError(() => removeSessionDir(plan.sessionDir)));
        },
      });
    }),
  );

export interface BwrapServiceFakeConfig {
  readonly write?: (plan: BwrapWritePlan) => Effect.Effect<BwrapHandle>;
}

export interface BwrapServiceFake {
  readonly layer: Layer.Layer<BwrapService>;
  /** Records every `write` call made against the fake, for test assertions. */
  readonly writes: BwrapWritePlan[];
}

export function makeBwrapServiceFake(
  overrides: BwrapServiceFakeConfig = {},
): BwrapServiceFake {
  const writes: BwrapWritePlan[] = [];
  const defaultWrite = (plan: BwrapWritePlan): Effect.Effect<BwrapHandle> =>
    Effect.succeed({
      seccompProfilePath: path.join(plan.sessionDir, "seccomp.json"),
      close: () => Effect.void,
    });
  const write = overrides.write ?? defaultWrite;
  const layer = Layer.succeed(
    BwrapService,
    BwrapService.of({
      write: (plan) =>
        Effect.sync(() => {
          writes.push(plan);
        }).pipe(Effect.andThen(() => write(plan))),
    }),
  );
  return { layer, writes };
}
