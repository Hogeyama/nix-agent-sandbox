/**
 * nas rebuild サブコマンド
 */

import { loadConfig, resolveProfile } from "../config/load.ts";
import { createContext } from "../pipeline/context.ts";
import {
  createDockerBuildStage,
  resolveBuildProbes,
} from "../stages/launch.ts";
import { teardownHandles } from "../pipeline/effects.ts";
import { dockerImageExists, dockerRemoveImage } from "../docker/client.ts";
import { logInfo } from "../log.ts";
import { exitOnCliError, parseLogLevel } from "./helpers.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import { executePlan } from "../pipeline/effects.ts";
import type { PriorStageOutputs } from "../pipeline/types.ts";

export async function runRebuild(nasArgs: string[]): Promise<void> {
  const force = nasArgs.includes("--force") || nasArgs.includes("-f");
  const profileName = nasArgs.find((a) => !a.startsWith("-"));
  const logLevel = parseLogLevel(nasArgs);
  try {
    const config = await loadConfig();
    const { name, profile } = resolveProfile(config, profileName);
    const ctx = createContext(config, profile, name, Deno.cwd(), logLevel);

    if (await dockerImageExists(ctx.imageName)) {
      logInfo(`[nas] Removing Docker image "${ctx.imageName}"...`);
      await dockerRemoveImage(ctx.imageName, { force });
    } else {
      logInfo(
        `[nas] Docker image "${ctx.imageName}" does not exist, skipping removal`,
      );
    }

    // Image was just removed, so probes will report imageExists=false
    const buildProbes = await resolveBuildProbes(ctx.imageName);
    const stage = createDockerBuildStage(buildProbes);

    const hostEnv = buildHostEnv();
    const probes = await resolveProbes(hostEnv);
    const prior: PriorStageOutputs = {
      dockerArgs: [],
      envVars: {},
      workDir: ctx.workDir,
      nixEnabled: false,
      imageName: ctx.imageName,
      agentCommand: [],
      networkPromptEnabled: false,
      dbusProxyEnabled: false,
    };
    const plan = stage.plan({
      config,
      profile,
      profileName: name,
      sessionId: ctx.sessionId,
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
