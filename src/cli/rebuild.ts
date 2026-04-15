/**
 * nas rebuild サブコマンド
 */

import { Effect, Layer } from "effect";
import {
  adaptEffectStageToPipelineStateStage,
  createCliInitialState,
} from "./pipeline_state.ts";
import { loadConfig, resolveProfile } from "../config/load.ts";
import { dockerImageExists, dockerRemoveImage } from "../docker/client.ts";
import { logInfo } from "../log.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import type { PipelineState, WorkspaceState } from "../pipeline/state.ts";
import { createPipelineBuilder } from "../pipeline/stage_builder.ts";
import type { PriorStageOutputs, StageInput } from "../pipeline/types.ts";
import { DockerServiceLive } from "../services/docker.ts";
import { DockerBuildServiceLive } from "../services/docker_build.ts";
import { FsServiceLive } from "../services/fs.ts";
import {
  createDockerBuildStage,
  type BuildProbes,
  resolveBuildProbes,
} from "../stages/docker_build.ts";
import { exitOnCliError } from "./helpers.ts";

export function createRebuildPrior(
  workDir: string,
  imageName: string,
): PriorStageOutputs & { workspace: WorkspaceState } {
  const initialState = createCliInitialState(workDir, imageName);
  return {
    dockerArgs: [],
    envVars: {},
    workDir,
    nixEnabled: false,
    imageName,
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...initialState,
  };
}

export function createRebuildPipelineBuilder({
  input,
  initialPrior,
  buildProbes,
}: {
  readonly input: Omit<StageInput, "prior">;
  readonly initialPrior: PriorStageOutputs & Pick<PipelineState, "workspace">;
  readonly buildProbes: BuildProbes;
}) {
  const priorRef: {
    current: PriorStageOutputs & Partial<PipelineState>;
  } = { current: initialPrior };

  return createPipelineBuilder<Pick<PipelineState, "workspace">>().add(
    adaptEffectStageToPipelineStateStage(
      {
        stage: createDockerBuildStage(buildProbes),
        needs: ["workspace"],
        pickAdds: () => ({}),
      },
      input,
      priorRef,
    ),
  );
}

export async function runRebuild(nasArgs: string[]): Promise<void> {
  const force = nasArgs.includes("--force") || nasArgs.includes("-f");
  const profileName = nasArgs.find((a) => !a.startsWith("-"));
  try {
    const config = await loadConfig();
    const { name, profile } = resolveProfile(config, profileName);
    const imageName = "nas-sandbox";
    const sessionId = `sess_${randomHex(6)}`;

    if (await dockerImageExists(imageName)) {
      logInfo(`[nas] Removing Docker image "${imageName}"...`);
      await dockerRemoveImage(imageName, { force });
    } else {
      logInfo(
        `[nas] Docker image "${imageName}" does not exist, skipping removal`,
      );
    }

    const buildProbes = await resolveBuildProbes(imageName);

    const hostEnv = buildHostEnv();
    const probes = await resolveProbes(hostEnv);
    const prior = createRebuildPrior(process.cwd(), imageName);
    const builder = createRebuildPipelineBuilder({
      input: {
        config,
        profile,
        profileName: name,
        sessionId,
        host: hostEnv,
        probes,
      },
      initialPrior: prior,
      buildProbes,
    });

    const effect = builder.run({ workspace: prior.workspace }).pipe(
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

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(data).toString("hex");
}
