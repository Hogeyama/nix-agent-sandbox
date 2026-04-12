/**
 * nas rebuild サブコマンド
 */

import { Effect } from "effect";
import { loadConfig, resolveProfile } from "../config/load.ts";
import { dockerImageExists, dockerRemoveImage } from "../docker/client.ts";
import { logInfo } from "../log.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import type { PriorStageOutputs } from "../pipeline/types.ts";
import { DockerServiceLive } from "../services/docker.ts";
import { FsServiceLive } from "../services/fs.ts";
import {
  createDockerBuildStage,
  resolveBuildProbes,
} from "../stages/docker_build.ts";
import { exitOnCliError } from "./helpers.ts";

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
    const stage = createDockerBuildStage(buildProbes);

    const hostEnv = buildHostEnv();
    const probes = await resolveProbes(hostEnv);
    const prior: PriorStageOutputs = {
      dockerArgs: [],
      envVars: {},
      workDir: process.cwd(),
      nixEnabled: false,
      imageName,
      agentCommand: [],
      networkPromptEnabled: false,
      dbusProxyEnabled: false,
    };

    const effect = stage
      .run({
        config,
        profile,
        profileName: name,
        sessionId,
        host: hostEnv,
        probes,
        prior,
      })
      .pipe(
        Effect.scoped,
        Effect.provide(DockerServiceLive),
        Effect.provide(FsServiceLive),
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
