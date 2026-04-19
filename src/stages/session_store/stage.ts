/**
 * SessionStoreStage (EffectStage)
 *
 * Creates a runtime session record on pipeline startup and deletes
 * it on teardown (via Effect.addFinalizer). Hook events from
 * inside the container reach the host session store via HostExec
 * (the __nas_hook rule), so no bind-mounts are needed here.
 */

import { Effect, type Scope } from "effect";
import { logInfo } from "../../log.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { SessionState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { SessionStoreService } from "./session_store_service.ts";

function resolveWorktree(input: { workspace: { workDir: string } }): string {
  return input.workspace.workDir;
}

function buildSessionResult(input: StageInput): { session: SessionState } {
  const session: SessionState =
    input.sessionName === undefined
      ? { sessionId: input.sessionId }
      : { sessionId: input.sessionId, sessionName: input.sessionName };

  return {
    session,
  };
}

export function createSessionStoreStage(
  shared?: StageInput,
): Stage<"workspace", { session: SessionState }, SessionStoreService, unknown> {
  return {
    name: "SessionStoreStage",
    needs: ["workspace"],

    run(
      input,
    ): Effect.Effect<
      { session: SessionState },
      unknown,
      Scope.Scope | SessionStoreService
    > {
      const stageInput = (shared ??
        (input as unknown as StageInput)) as StageInput;
      return Effect.gen(function* () {
        const sessionStore = yield* SessionStoreService;

        // Resolve the host runtime directory. Passing `undefined` lets the
        // helper honor NAS_SESSION_STORE_DIR on the host side (mainly useful
        // in tests) and otherwise fall back to the XDG-aware default.
        const paths = yield* sessionStore.ensurePaths();

        yield* sessionStore.create(paths, {
          sessionId: stageInput.sessionId,
          name: stageInput.sessionName,
          agent: stageInput.profile.agent,
          profile: stageInput.profileName,
          worktree: resolveWorktree(input),
          startedAt: new Date().toISOString(),
          hookNotify: stageInput.profile.hook.notify,
        });

        logInfo(
          `[nas] Session store: created record ${stageInput.sessionId} at ${paths.sessionsDir}`,
        );

        // Best-effort cleanup: a missing record (e.g. already deleted by
        // something else) must not surface as a teardown error.
        yield* Effect.addFinalizer(() =>
          sessionStore
            .delete(paths, stageInput.sessionId)
            .pipe(Effect.ignoreLogged),
        );

        return buildSessionResult(stageInput);
      });
    },
  };
}
