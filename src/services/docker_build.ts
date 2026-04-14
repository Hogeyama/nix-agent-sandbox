/**
 * DockerBuildService — Effect-based abstraction over Docker image build lifecycle.
 *
 * Manages temp directory creation, asset copying, Docker build invocation,
 * and temp directory cleanup.
 *
 * Live implementation delegates to FsService + DockerService.
 * Fake implementation provides configurable stubs for testing.
 */

import { tmpdir } from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, type Scope } from "effect";
import { logInfo } from "../log.ts";
import { DockerService } from "./docker.ts";
import { FsService } from "./fs.ts";

// ---------------------------------------------------------------------------
// Service-local plan interface (avoids service → stage dependency)
// ---------------------------------------------------------------------------

export interface DockerBuildImagePlan {
  readonly assetGroups: ReadonlyArray<{
    readonly baseDir: string;
    readonly outputDir: string;
    readonly files: readonly string[];
  }>;
  readonly imageName: string;
  readonly labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// DockerBuildService tag
// ---------------------------------------------------------------------------

export class DockerBuildService extends Context.Tag("nas/DockerBuildService")<
  DockerBuildService,
  {
    readonly buildImage: (
      plan: DockerBuildImagePlan,
    ) => Effect.Effect<void, unknown, Scope.Scope>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const DockerBuildServiceLive: Layer.Layer<
  DockerBuildService,
  never,
  FsService | DockerService
> = Layer.effect(
  DockerBuildService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const docker = yield* DockerService;

    return DockerBuildService.of({
      buildImage: (plan) =>
        Effect.gen(function* () {
          const tmpDir = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const dir = yield* fs.mkdtemp(
                path.join(tmpdir(), "nas-docker-build-"),
              );
              for (const group of plan.assetGroups) {
                for (const name of group.files) {
                  const content = yield* fs.readFile(
                    path.join(group.baseDir, name),
                  );
                  const outputPath = path.join(dir, group.outputDir, name);
                  yield* fs.mkdir(path.dirname(outputPath), {
                    recursive: true,
                  });
                  yield* fs.writeFile(outputPath, content);
                }
              }
              return dir;
            }),
            (dir) =>
              fs
                .rm(dir, { recursive: true, force: true })
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.sync(() =>
                      logInfo(
                        `[nas] DockerBuild: failed to remove temp dir: ${e}`,
                      ),
                    ),
                  ),
                ),
          );
          yield* docker.build(tmpDir, plan.imageName, plan.labels);
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface DockerBuildServiceFakeConfig {
  readonly buildImage?: (
    plan: DockerBuildImagePlan,
  ) => Effect.Effect<void, unknown, Scope.Scope>;
}

export function makeDockerBuildServiceFake(
  overrides: DockerBuildServiceFakeConfig = {},
): Layer.Layer<DockerBuildService> {
  return Layer.succeed(
    DockerBuildService,
    DockerBuildService.of({
      buildImage: overrides.buildImage ?? (() => Effect.void),
    }),
  );
}
