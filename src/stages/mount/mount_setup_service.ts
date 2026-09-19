/**
 * MountSetupService — Effect-based abstraction over mount directory preparation.
 *
 * Prepares mount sources and owns the protected Claude state lifetime.
 *
 * Live implementation delegates to filesystem helpers and FsService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer, type Scope } from "effect";
import type { ProtectedClaudeState } from "../../agents/types.ts";
import { FsService } from "../../services/fs.ts";
import {
  prepareProtectedClaudeState,
  removeProtectedClaudeState,
} from "./claude_state_fs.ts";

// ---------------------------------------------------------------------------
// Service-local plan interface (avoids service -> stage dependency)
// ---------------------------------------------------------------------------

export interface MountDirectoryEntry {
  readonly path: string;
  readonly mode?: number;
}

// ---------------------------------------------------------------------------
// MountSetupService tag
// ---------------------------------------------------------------------------

export class MountSetupService extends Context.Tag("nas/MountSetupService")<
  MountSetupService,
  {
    readonly prepareClaudeState: (
      hostHome: string,
    ) => Effect.Effect<ProtectedClaudeState, unknown, Scope.Scope>;
    readonly ensureDirectories: (
      dirs: ReadonlyArray<MountDirectoryEntry>,
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const MountSetupServiceLive: Layer.Layer<
  MountSetupService,
  never,
  FsService
> = Layer.effect(
  MountSetupService,
  Effect.gen(function* () {
    const fs = yield* FsService;

    return MountSetupService.of({
      prepareClaudeState: (hostHome) =>
        Effect.acquireRelease(
          Effect.tryPromise(() => prepareProtectedClaudeState(hostHome)),
          (state) => Effect.promise(() => removeProtectedClaudeState(state)),
        ),
      ensureDirectories: (dirs) =>
        Effect.gen(function* () {
          for (const dir of dirs) {
            yield* fs.mkdir(dir.path, { recursive: true, mode: dir.mode });
          }
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface MountSetupServiceFakeConfig {
  readonly prepareClaudeState?: (
    hostHome: string,
  ) => Effect.Effect<ProtectedClaudeState, unknown, Scope.Scope>;
  readonly ensureDirectories?: (
    dirs: ReadonlyArray<MountDirectoryEntry>,
  ) => Effect.Effect<void>;
}

export function makeMountSetupServiceFake(
  overrides: MountSetupServiceFakeConfig = {},
): Layer.Layer<MountSetupService> {
  return Layer.succeed(
    MountSetupService,
    MountSetupService.of({
      prepareClaudeState:
        overrides.prepareClaudeState ??
        (() => Effect.die("prepareClaudeState fake is required")),
      ensureDirectories: overrides.ensureDirectories ?? (() => Effect.void),
    }),
  );
}
