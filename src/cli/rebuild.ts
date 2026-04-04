/**
 * nas rebuild サブコマンド
 */

import { encodeHex } from "@std/encoding/hex";
import { loadConfig, resolveProfile } from "../config/load.ts";
import {
  createDockerBuildStage,
  resolveBuildProbes,
} from "../stages/launch.ts";
import { executePlan, teardownHandles } from "../pipeline/effects.ts";
import { dockerImageExists, dockerRemoveImage } from "../docker/client.ts";
import { logInfo } from "../log.ts";
import { exitOnCliError } from "./helpers.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import type { PriorStageOutputs } from "../pipeline/types.ts";

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

    // Image was just removed, so probes will report imageExists=false
    const buildProbes = await resolveBuildProbes(imageName);
    const stage = createDockerBuildStage(buildProbes);

    const hostEnv = buildHostEnv();
    const probes = await resolveProbes(hostEnv);
    const prior: PriorStageOutputs = {
      dockerArgs: [],
      envVars: {},
      workDir: Deno.cwd(),
      nixEnabled: false,
      imageName,
      agentCommand: [],
      networkPromptEnabled: false,
      dbusProxyEnabled: false,
    };
    const plan = stage.plan({
      config,
      profile,
      profileName: name,
      sessionId,
      host: hostEnv,
      probes,
      prior,
    });
    if (plan) {
      const handles = await executePlan(plan);
      await teardownHandles(handles);
    }
  } catch (err) {
    exitOnCliError(err);
  }
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return encodeHex(data);
}
