/**
 * MountSetupService — Effect-based abstraction over mount directory preparation.
 *
 * Creates directories required by the mount stage.
 *
 * Live implementation delegates to FsService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";

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
      ensureDirectories: overrides.ensureDirectories ?? (() => Effect.void),
    }),
  );
}
