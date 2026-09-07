/**
 * HostExecSetupService — owns preparation and cleanup of hostexec wrapper
 * entries for one session.
 */

import { Cause, Context, Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";

export interface HostExecWorkspacePlan {
  readonly directories: ReadonlyArray<{ path: string; mode: number }>;
  readonly symlinks: ReadonlyArray<{ target: string; path: string }>;
  readonly script?: {
    readonly runtimePath: string;
    readonly content: string;
  };
}

export interface HostExecSetupHandle {
  readonly close: () => Effect.Effect<void>;
}

export class HostExecSetupService extends Context.Tag(
  "nas/HostExecSetupService",
)<
  HostExecSetupService,
  {
    readonly prepareWorkspace: (
      plan: HostExecWorkspacePlan,
    ) => Effect.Effect<HostExecSetupHandle>;
  }
>() {}

interface HostExecSetupOpsShape {
  readonly mkdir: (target: string, mode: number) => Effect.Effect<void>;
  readonly writeFile: (target: string, content: string) => Effect.Effect<void>;
  readonly chmod: (target: string, mode: number) => Effect.Effect<void>;
  readonly symlink: (target: string, linkPath: string) => Effect.Effect<void>;
  readonly removeScript: (target: string) => Effect.Effect<void>;
}

class HostExecSetupOps extends Context.Tag("nas/HostExecSetupOps")<
  HostExecSetupOps,
  HostExecSetupOpsShape
>() {}

function makeHostExecSetupOpsLayer(
  fs: Context.Tag.Service<FsService>,
): Layer.Layer<HostExecSetupOps> {
  return Layer.succeed(
    HostExecSetupOps,
    HostExecSetupOps.of({
      mkdir: (target, mode) => fs.mkdir(target, { recursive: true, mode }),
      writeFile: (target, content) =>
        fs.writeFile(target, content, { mode: 0o755 }),
      chmod: (target, mode) => fs.chmod(target, mode),
      symlink: (target, linkPath) => fs.symlink(target, linkPath),
      removeScript: (target) => fs.rm(target, { force: true }),
    }),
  );
}

function safelyRemoveScript(
  ops: HostExecSetupOpsShape,
  runtimePath: string,
): Effect.Effect<void> {
  return ops
    .removeScript(runtimePath)
    .pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(
          `HostExecSetupService: failed to remove script ${runtimePath}: ${Cause.pretty(cause)}`,
        ),
      ),
    );
}

function prepareHostExecWorkspace(
  plan: HostExecWorkspacePlan,
): Effect.Effect<HostExecSetupHandle, never, HostExecSetupOps> {
  return Effect.gen(function* () {
    const ops = yield* HostExecSetupOps;
    const prepare = Effect.gen(function* () {
      for (const directory of plan.directories) {
        yield* ops.mkdir(directory.path, directory.mode);
      }

      if (plan.script) {
        yield* ops.writeFile(plan.script.runtimePath, plan.script.content);
        yield* ops.chmod(plan.script.runtimePath, 0o755);
      }

      for (const link of plan.symlinks) {
        yield* ops.symlink(link.target, link.path);
      }
    });

    if (plan.script) {
      const runtimePath = plan.script.runtimePath;
      yield* prepare.pipe(
        Effect.onError(() => safelyRemoveScript(ops, runtimePath)),
      );
      return { close: () => safelyRemoveScript(ops, runtimePath) };
    }

    yield* prepare;
    return { close: () => Effect.void };
  });
}

export const HostExecSetupServiceLive: Layer.Layer<
  HostExecSetupService,
  never,
  FsService
> = Layer.effect(
  HostExecSetupService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const opsLayer = makeHostExecSetupOpsLayer(fs);
    return HostExecSetupService.of({
      prepareWorkspace: (plan) =>
        prepareHostExecWorkspace(plan).pipe(Effect.provide(opsLayer)),
    });
  }),
);

export interface HostExecSetupServiceFakeConfig {
  readonly prepareWorkspace?: (
    plan: HostExecWorkspacePlan,
  ) => Effect.Effect<HostExecSetupHandle>;
}

export function makeHostExecSetupServiceFake(
  overrides: HostExecSetupServiceFakeConfig = {},
): Layer.Layer<HostExecSetupService> {
  return Layer.succeed(
    HostExecSetupService,
    HostExecSetupService.of({
      prepareWorkspace:
        overrides.prepareWorkspace ??
        (() => Effect.succeed({ close: () => Effect.void })),
    }),
  );
}
