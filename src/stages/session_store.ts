/**
 * SessionStoreStage (EffectStage)
 *
 * Creates a runtime session record on pipeline startup and deletes
 * it on teardown (via Effect.addFinalizer). Hook events from
 * inside the container reach the host session store via HostExec
 * (the __nas_hook rule), so no bind-mounts are needed here.
 */

import { Effect, type Scope } from "effect";
import { logInfo } from "../log.ts";
import type {
  EffectStage,
  EffectStageResult,
  StageInput,
} from "../pipeline/types.ts";
import { SessionStoreService } from "../services/session_store_service.ts";

export function createSessionStoreStage(): EffectStage<SessionStoreService> {
  return {
    kind: "effect",
    name: "SessionStoreStage",

    run(
      input: StageInput,
    ): Effect.Effect<
      EffectStageResult,
      unknown,
      Scope.Scope | SessionStoreService
    > {
      return Effect.gen(function* () {
        const sessionStore = yield* SessionStoreService;

        // Resolve the host runtime directory. Passing `undefined` lets the
        // helper honor NAS_SESSION_STORE_DIR on the host side (mainly useful
        // in tests) and otherwise fall back to the XDG-aware default.
        const paths = yield* sessionStore.ensurePaths();

        yield* sessionStore.create(paths, {
          sessionId: input.sessionId,
          agent: input.profile.agent,
          profile: input.profileName,
          worktree: input.prior.workDir,
          startedAt: new Date().toISOString(),
          hookNotify: input.profile.hook.notify,
        });

        logInfo(
          `[nas] Session store: created record ${input.sessionId} at ${paths.sessionsDir}`,
        );

        // Best-effort cleanup: a missing record (e.g. already deleted by
        // something else) must not surface as a teardown error.
        yield* Effect.addFinalizer(() =>
          sessionStore.delete(paths, input.sessionId).pipe(Effect.ignoreLogged),
        );

        return {
          dockerArgs: [...input.prior.dockerArgs],
          envVars: {
            ...input.prior.envVars,
          },
        };
      });
    },
  };
}
