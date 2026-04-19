/**
 * HostExecSetupService — Effect-based abstraction over hostexec workspace preparation.
 *
 * Creates directories, writes files, and creates symlinks required by the hostexec stage.
 *
 * Live implementation delegates to FsService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";

// ---------------------------------------------------------------------------
// Service-local plan interface (avoids service → stage dependency)
// ---------------------------------------------------------------------------

export interface HostExecWorkspacePlan {
  readonly directories: ReadonlyArray<{ path: string; mode: number }>;
  readonly files: ReadonlyArray<{
    path: string;
    content: string;
    mode: number;
  }>;
  readonly symlinks: ReadonlyArray<{ target: string; path: string }>;
}

// ---------------------------------------------------------------------------
// HostExecSetupService tag
// ---------------------------------------------------------------------------

export class HostExecSetupService extends Context.Tag(
  "nas/HostExecSetupService",
)<
  HostExecSetupService,
  {
    readonly prepareWorkspace: (
      plan: HostExecWorkspacePlan,
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const HostExecSetupServiceLive: Layer.Layer<
  HostExecSetupService,
  never,
  FsService
> = Layer.effect(
  HostExecSetupService,
  Effect.gen(function* () {
    const fs = yield* FsService;

    return HostExecSetupService.of({
      prepareWorkspace: (plan) =>
        Effect.gen(function* () {
          for (const dir of plan.directories) {
            yield* fs.mkdir(dir.path, { recursive: true, mode: dir.mode });
          }

          for (const file of plan.files) {
            yield* fs.writeFile(file.path, file.content, { mode: file.mode });
          }

          for (const link of plan.symlinks) {
            yield* fs.symlink(link.target, link.path);
          }
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface HostExecSetupServiceFakeConfig {
  readonly prepareWorkspace?: (
    plan: HostExecWorkspacePlan,
  ) => Effect.Effect<void>;
}

export function makeHostExecSetupServiceFake(
  overrides: HostExecSetupServiceFakeConfig = {},
): Layer.Layer<HostExecSetupService> {
  return Layer.succeed(
    HostExecSetupService,
    HostExecSetupService.of({
      prepareWorkspace: overrides.prepareWorkspace ?? (() => Effect.void),
    }),
  );
}
