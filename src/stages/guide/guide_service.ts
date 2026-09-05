/**
 * GuideService — places the generated guide in the host-side runtime dir and
 * cleans it up at session end, as a single unit of intent.
 */

import * as path from "node:path";
import { Cause, Context, Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";

export interface GuideWritePlan {
  /** Directory to place `SKILL.md` in. This is the skill's own directory. */
  readonly dir: string;
  readonly content: string;
}

export interface GuideHandle {
  readonly close: () => Effect.Effect<void>;
}

export class GuideService extends Context.Tag("nas/GuideService")<
  GuideService,
  {
    readonly write: (plan: GuideWritePlan) => Effect.Effect<GuideHandle>;
  }
>() {}

export const GuideServiceLive: Layer.Layer<GuideService, never, FsService> =
  Layer.effect(
    GuideService,
    Effect.gen(function* () {
      const fs = yield* FsService;
      return GuideService.of({
        write: (plan) =>
          Effect.gen(function* () {
            yield* fs.mkdir(plan.dir, { recursive: true, mode: 0o755 });
            yield* fs.writeFile(path.join(plan.dir, "SKILL.md"), plan.content, {
              mode: 0o644,
            });
            return {
              close: () =>
                fs.rm(plan.dir, { recursive: true, force: true }).pipe(
                  // fs.rm ends in Effect.orDie, so a real failure (EBUSY,
                  // EPERM, ...) surfaces as a defect, not a typed error.
                  // Effect.catchAll only sees the (empty) error channel and
                  // would let the defect escape the finalizer. Use
                  // catchAllCause to intercept it, and log rather than
                  // swallow so a leftover directory is diagnosable.
                  Effect.catchAllCause((cause) =>
                    Effect.logWarning(
                      `GuideService: failed to remove ${plan.dir}: ${Cause.pretty(cause)}`,
                    ),
                  ),
                ),
            };
          }),
      });
    }),
  );

export interface GuideServiceFakeConfig {
  readonly write?: (plan: GuideWritePlan) => Effect.Effect<GuideHandle>;
}

export interface GuideServiceFake {
  readonly layer: Layer.Layer<GuideService>;
  /** Records every `write` call made against the fake, for test assertions. */
  readonly writes: GuideWritePlan[];
}

export function makeGuideServiceFake(
  overrides: GuideServiceFakeConfig = {},
): GuideServiceFake {
  const writes: GuideWritePlan[] = [];
  const defaultWrite = (): Effect.Effect<GuideHandle> =>
    Effect.succeed({ close: () => Effect.void });
  const write = overrides.write ?? defaultWrite;
  const layer = Layer.succeed(
    GuideService,
    GuideService.of({
      write: (plan) =>
        Effect.sync(() => {
          writes.push(plan);
        }).pipe(Effect.andThen(() => write(plan))),
    }),
  );
  return { layer, writes };
}
