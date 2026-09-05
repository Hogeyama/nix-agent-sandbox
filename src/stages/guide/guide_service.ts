/**
 * GuideService — places the generated guide in the host-side runtime dir and
 * cleans it up at session end, as a single unit of intent.
 */

import * as path from "node:path";
import { Cause, Context, Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";
import { GUIDE_SKILL_NAME } from "./content.ts";

export interface GuideWritePlan {
  /**
   * Session directory: the unit this service owns. `write` creates it (and
   * the skill directory beneath it) and `close` removes it whole, so no
   * empty per-session directory is left behind once the skill directory
   * itself is gone.
   */
  readonly sessionDir: string;
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

      // fs.rm ends in Effect.orDie, so a real failure (EBUSY, EPERM, ...)
      // surfaces as a defect, not a typed error. Effect.catchAll only sees
      // the (empty) error channel and would let the defect escape. Use
      // catchAllCause to intercept it, and log rather than swallow so a
      // leftover directory is diagnosable.
      const removeSessionDir = (sessionDir: string): Effect.Effect<void> =>
        fs
          .rm(sessionDir, { recursive: true, force: true })
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.logWarning(
                `GuideService: failed to remove ${sessionDir}: ${Cause.pretty(cause)}`,
              ),
            ),
          );

      return GuideService.of({
        write: (plan) => {
          const skillDir = path.join(plan.sessionDir, GUIDE_SKILL_NAME);
          return Effect.gen(function* () {
            // The session directory never leaves the host, so it stays
            // private (0o700), matching every other per-session runtime
            // directory in this repository. The skill directory is the
            // bind-mount source and must stay readable inside the
            // container, so it keeps the more permissive mode.
            yield* fs.mkdir(plan.sessionDir, { recursive: true, mode: 0o700 });
            yield* fs.mkdir(skillDir, { recursive: true, mode: 0o755 });
            yield* fs.writeFile(path.join(skillDir, "SKILL.md"), plan.content, {
              mode: 0o644,
            });
            return { close: () => removeSessionDir(plan.sessionDir) };
          }).pipe(
            // If mkdir succeeds but writeFile then dies, the effect above
            // never returns a handle, so Effect.acquireRelease's caller
            // never gets to register a release for what was already
            // created on disk. Clean up here instead, on the failure path
            // itself, so a partially-created session directory cannot
            // outlive this call.
            Effect.onError(() => removeSessionDir(plan.sessionDir)),
          );
        },
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
