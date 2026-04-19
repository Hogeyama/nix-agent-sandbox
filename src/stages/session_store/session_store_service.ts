/**
 * SessionStoreService — Effect-based abstraction over session CRUD operations.
 *
 * Live implementation delegates to existing functions in src/sessions/store.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type {
  SessionRecord,
  SessionRuntimePaths,
} from "../../sessions/store.ts";
import {
  createSession,
  deleteSession,
  ensureSessionRuntimePaths,
} from "../../sessions/store.ts";

// ---------------------------------------------------------------------------
// Input type for create (mirrors what the existing createSession accepts)
// ---------------------------------------------------------------------------

export type CreateSessionInput = Omit<SessionRecord, "turn" | "lastEventAt"> & {
  startedAt: string;
};

// ---------------------------------------------------------------------------
// SessionStoreService tag
// ---------------------------------------------------------------------------

export class SessionStoreService extends Context.Tag("nas/SessionStoreService")<
  SessionStoreService,
  {
    readonly ensurePaths: (
      baseDir?: string,
    ) => Effect.Effect<SessionRuntimePaths>;
    readonly create: (
      paths: SessionRuntimePaths,
      record: CreateSessionInput,
    ) => Effect.Effect<void>;
    readonly delete: (
      paths: SessionRuntimePaths,
      sessionId: string,
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const SessionStoreServiceLive: Layer.Layer<SessionStoreService> =
  Layer.succeed(
    SessionStoreService,
    SessionStoreService.of({
      ensurePaths: (baseDir) =>
        Effect.tryPromise({
          try: () => ensureSessionRuntimePaths(baseDir),
          catch: (e) =>
            new Error(
              `ensureSessionRuntimePaths failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        }).pipe(Effect.orDie),

      create: (paths, record) =>
        Effect.tryPromise({
          try: () => createSession(paths, record).then(() => undefined),
          catch: (e) =>
            new Error(
              `createSession failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        }).pipe(Effect.orDie),

      delete: (paths, sessionId) =>
        Effect.tryPromise({
          try: () => deleteSession(paths, sessionId),
          catch: (e) =>
            new Error(
              `deleteSession failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        }).pipe(Effect.orDie),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface SessionStoreServiceFakeConfig {
  readonly ensurePaths?: (
    baseDir?: string,
  ) => Effect.Effect<SessionRuntimePaths>;
  readonly create?: (
    paths: SessionRuntimePaths,
    record: CreateSessionInput,
  ) => Effect.Effect<void>;
  readonly delete?: (
    paths: SessionRuntimePaths,
    sessionId: string,
  ) => Effect.Effect<void>;
}

const defaultFakePaths: SessionRuntimePaths = {
  runtimeDir: "/tmp/nas-fake",
  sessionsDir: "/tmp/nas-fake/sessions",
};

export function makeSessionStoreServiceFake(
  overrides: SessionStoreServiceFakeConfig = {},
): Layer.Layer<SessionStoreService> {
  return Layer.succeed(
    SessionStoreService,
    SessionStoreService.of({
      ensurePaths:
        overrides.ensurePaths ?? (() => Effect.succeed(defaultFakePaths)),
      create: overrides.create ?? (() => Effect.void),
      delete: overrides.delete ?? (() => Effect.void),
    }),
  );
}
