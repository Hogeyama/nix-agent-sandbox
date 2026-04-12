/**
 * SessionStoreStage (EffectStage)
 *
 * Creates a runtime session record on pipeline startup and deletes
 * it on teardown (via Effect.addFinalizer). Also injects a bind-mount
 * of the host session runtime directory onto a canonical in-container
 * path so hooks running inside the sandbox land on the same on-disk
 * store as the host-side UI.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { Effect, type Scope } from "effect";
import { logInfo } from "../log.ts";
import type {
  EffectStage,
  EffectStageResult,
  StageInput,
} from "../pipeline/types.ts";
import { SessionStoreService } from "../services/session_store_service.ts";

/** Canonical path the in-container hook uses to reach the session store. */
export const IN_CONTAINER_SESSION_STORE_DIR = "/run/nas/sessions";

/** Canonical in-container path for the mounted `nas` binary. Already on PATH. */
export const IN_CONTAINER_NAS_BIN_PATH = "/usr/local/bin/nas";

/**
 * Locate the host `nas` artifact to bind-mount into the sandbox so agent
 * hooks can call `nas hook notification ...`. Only trusts an explicit
 * `NAS_BIN_PATH` — auto-detection (`process.execPath`, `Bun.which`) is
 * unsafe because the common distribution shapes are not self-contained:
 *
 * - The nix non-bundled wrapper (`$out/bin/nas`) is a shell script that
 *   `exec`s a sibling path under the host nix store; mounting it into the
 *   container breaks because that sibling does not exist there.
 * - The nix `single-exe` self-extracting script decompresses itself into
 *   `$TMPDIR` at runtime, so `process.execPath` points at the extracted
 *   `orig/nas` with LD_LIBRARY_PATH / LD_PRELOAD deps that were extracted
 *   alongside it — also not mountable.
 *
 * Only the pre-extraction self-extracting script OR a pure
 * `bun build --compile` output is safely mountable, and we cannot
 * distinguish those from the unsafe shapes at runtime. Require the user
 * (or packaging) to tell us explicitly via `NAS_BIN_PATH`.
 */
export function resolveNasBinPath(): string | null {
  const envPath = process.env.NAS_BIN_PATH;
  if (envPath && isRegularFile(envPath)) {
    return safeRealpath(envPath);
  }
  return null;
}

function isRegularFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

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
        });

        logInfo(
          `[nas] Session store: created record ${input.sessionId} at ${paths.sessionsDir}`,
        );

        // Best-effort cleanup: a missing record (e.g. already deleted by
        // something else) must not surface as a teardown error.
        yield* Effect.addFinalizer(() =>
          sessionStore.delete(paths, input.sessionId).pipe(Effect.ignoreLogged),
        );

        const dockerArgs: string[] = [
          "-v",
          `${paths.sessionsDir}:${IN_CONTAINER_SESSION_STORE_DIR}`,
        ];

        const nasBinPath = resolveNasBinPath();
        if (nasBinPath) {
          dockerArgs.push(
            "-v",
            `${nasBinPath}:${IN_CONTAINER_NAS_BIN_PATH}:ro`,
          );
        } else {
          logInfo(
            "[nas] hook notification: NAS_BIN_PATH is not set — in-sandbox agent hooks that call `nas hook notification` will fail with 'command not found'. Point NAS_BIN_PATH at a self-contained nas artifact (a `bun build --compile` output or the nix `single-exe` self-extracting script).",
          );
        }

        return {
          dockerArgs,
          envVars: {
            NAS_SESSION_STORE_DIR: IN_CONTAINER_SESSION_STORE_DIR,
          },
        };
      });
    },
  };
}
