/**
 * nas rebuild サブコマンド
 */

import { loadConfig, resolveProfile } from "../config/load.ts";
import { createContext } from "../pipeline/context.ts";
import { runPipeline } from "../pipeline/pipeline.ts";
import { DockerBuildStage } from "../stages/launch.ts";
import { dockerImageExists, dockerRemoveImage } from "../docker/client.ts";
import { logInfo } from "../log.ts";
import { exitOnCliError, parseLogLevel } from "./helpers.ts";

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

    const stages = [new DockerBuildStage()];
    await runPipeline(stages, ctx);
  } catch (err) {
    exitOnCliError(err);
  }
}
