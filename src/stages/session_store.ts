/**
 * SessionStoreStage (ProceduralStage)
 *
 * Creates a runtime session record on pipeline startup and deletes
 * it on teardown. Also injects a bind-mount of the host session
 * runtime directory onto a canonical in-container path so hooks
 * running inside the sandbox land on the same on-disk store as the
 * host-side UI.
 */

import { logInfo } from "../log.ts";
import type {
  ProceduralResult,
  ProceduralStage,
  StageInput,
} from "../pipeline/types.ts";
import {
  createSession,
  deleteSession,
  ensureSessionRuntimePaths,
  type SessionRuntimePaths,
} from "../sessions/store.ts";

/** Canonical path the in-container hook uses to reach the session store. */
export const IN_CONTAINER_SESSION_STORE_DIR = "/run/nas/sessions";

export class SessionStoreStage implements ProceduralStage {
  kind = "procedural" as const;
  name = "SessionStoreStage";

  /** Resolved host paths — remembered for teardown. */
  private paths: SessionRuntimePaths | null = null;
  /** Session id — remembered for teardown (also available via input). */
  private sessionId: string | null = null;

  async execute(input: StageInput): Promise<ProceduralResult> {
    // Resolve the host runtime directory. Passing `undefined` lets the
    // helper honor NAS_SESSION_STORE_DIR on the host side (mainly useful
    // in tests) and otherwise fall back to the XDG-aware default.
    const paths = await ensureSessionRuntimePaths(undefined);
    this.paths = paths;
    this.sessionId = input.sessionId;

    await createSession(paths, {
      sessionId: input.sessionId,
      agent: input.profile.agent,
      profile: input.profileName,
      worktree: input.prior.workDir,
      startedAt: new Date().toISOString(),
    });

    logInfo(
      `[nas] Session store: created record ${input.sessionId} at ${paths.sessionsDir}`,
    );

    return {
      outputOverrides: {
        dockerArgs: [
          "-v",
          `${paths.sessionsDir}:${IN_CONTAINER_SESSION_STORE_DIR}`,
        ],
        envVars: {
          NAS_SESSION_STORE_DIR: IN_CONTAINER_SESSION_STORE_DIR,
        },
      },
    };
  }

  async teardown(input: StageInput): Promise<void> {
    // Best-effort cleanup: a missing record (e.g. already deleted by
    // something else) must not surface as a teardown error.
    const paths = this.paths;
    const sessionId = this.sessionId ?? input.sessionId;
    if (!paths) return;
    try {
      await deleteSession(paths, sessionId);
    } catch (err) {
      console.error(
        `[nas] SessionStoreStage teardown: failed to delete record ${sessionId}: ${
          (err as Error).message
        }`,
      );
    }
  }
}
