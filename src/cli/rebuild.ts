/**
 * nas rebuild サブコマンド
 */

import { Effect, Layer } from "effect";
import { dockerImageExists, dockerRemoveImage } from "../docker/client.ts";
import { logInfo } from "../log.ts";
import { createPipelineBuilder } from "../pipeline/stage_builder.ts";
import type { PipelineState } from "../pipeline/state.ts";
import { DockerServiceLive } from "../services/docker.ts";
import { FsServiceLive } from "../services/fs.ts";
import {
  type BuildProbes,
  createDockerBuildStage,
  DockerBuildServiceLive,
  resolveBuildProbes,
} from "../stages/docker_build.ts";
import { exitOnCliError } from "./helpers.ts";
import { createCliInitialState } from "./pipeline_state.ts";

export function createRebuildInitialState(
  workDir: string,
  imageName: string,
): Pick<PipelineState, "workspace" | "container"> {
  return createCliInitialState(workDir, imageName);
}

export function createRebuildPipelineBuilder({
  buildProbes,
}: {
  readonly buildProbes: BuildProbes;
}) {
  return createPipelineBuilder<
    Pick<PipelineState, "workspace" | "container">
  >().add(createDockerBuildStage(buildProbes));
}

export async function runRebuild(nasArgs: string[]): Promise<void> {
  const force = nasArgs.includes("--force") || nasArgs.includes("-f");
  try {
    const imageName = "nas-sandbox";

    if (await dockerImageExists(imageName)) {
      logInfo(`[nas] Removing Docker image "${imageName}"...`);
      await dockerRemoveImage(imageName, { force });
    } else {
      logInfo(
        `[nas] Docker image "${imageName}" does not exist, skipping removal`,
      );
    }

    const buildProbes = await resolveBuildProbes(imageName);
    const initialState = createRebuildInitialState(process.cwd(), imageName);
    const builder = createRebuildPipelineBuilder({
      buildProbes,
    });

    const effect = builder
      .run(initialState)
      .pipe(
        Effect.scoped,
        Effect.provide(
          DockerBuildServiceLive.pipe(
            Layer.provide(Layer.merge(FsServiceLive, DockerServiceLive)),
          ),
        ),
      );

    await Effect.runPromise(effect);
  } catch (err) {
    exitOnCliError(err);
  }
}
