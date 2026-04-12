/**
 * DtachService — Effect-based abstraction over dtach CLI operations.
 */

import { Context, Effect, Layer } from "effect";
import {
  type DtachSessionInfo,
  dtachAttach,
  dtachHasSession,
  dtachIsAvailable,
  dtachListSessions,
  dtachNewSession,
} from "../dtach/client.ts";

// ---------------------------------------------------------------------------
// DtachService tag
// ---------------------------------------------------------------------------

export class DtachService extends Context.Tag("nas/DtachService")<
  DtachService,
  {
    readonly isAvailable: () => Effect.Effect<boolean>;
    readonly newSession: (
      socketPath: string,
      shellCommand: string,
    ) => Effect.Effect<void>;
    readonly attach: (
      socketPath: string,
      detachKey?: string,
    ) => Effect.Effect<void>;
    readonly hasSession: (socketPath: string) => Effect.Effect<boolean>;
    readonly listSessions: () => Effect.Effect<DtachSessionInfo[]>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const DtachServiceLive: Layer.Layer<DtachService> = Layer.succeed(
  DtachService,
  DtachService.of({
    isAvailable: () =>
      Effect.tryPromise({
        try: () => dtachIsAvailable(),
        catch: () => new Error("dtach availability check failed"),
      }).pipe(Effect.orDie),

    newSession: (socketPath, shellCommand) =>
      Effect.tryPromise({
        try: () => dtachNewSession(socketPath, shellCommand),
        catch: (e) =>
          new Error(
            `dtach new session failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    attach: (socketPath, detachKey) =>
      Effect.tryPromise({
        try: () => dtachAttach(socketPath, detachKey),
        catch: (e) =>
          new Error(
            `dtach attach failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    hasSession: (socketPath) =>
      Effect.tryPromise({
        try: () => dtachHasSession(socketPath),
        catch: () => new Error("dtach has-session check failed"),
      }).pipe(Effect.orDie),

    listSessions: () =>
      Effect.tryPromise({
        try: () => dtachListSessions(),
        catch: () => new Error("dtach list-sessions failed"),
      }).pipe(Effect.orDie),
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface DtachServiceFakeConfig {
  readonly isAvailable?: () => Effect.Effect<boolean>;
  readonly newSession?: (
    socketPath: string,
    shellCommand: string,
  ) => Effect.Effect<void>;
  readonly attach?: (
    socketPath: string,
    detachKey?: string,
  ) => Effect.Effect<void>;
  readonly hasSession?: (socketPath: string) => Effect.Effect<boolean>;
  readonly listSessions?: () => Effect.Effect<DtachSessionInfo[]>;
}

export function makeDtachServiceFake(
  overrides: DtachServiceFakeConfig = {},
): Layer.Layer<DtachService> {
  return Layer.succeed(
    DtachService,
    DtachService.of({
      isAvailable: overrides.isAvailable ?? (() => Effect.succeed(true)),
      newSession: overrides.newSession ?? (() => Effect.void),
      attach: overrides.attach ?? (() => Effect.void),
      hasSession: overrides.hasSession ?? (() => Effect.succeed(false)),
      listSessions: overrides.listSessions ?? (() => Effect.succeed([])),
    }),
  );
}
