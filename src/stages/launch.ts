/**
 * Docker イメージビルド + コンテナ起動ステージ
 */

import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import { dockerBuild, dockerImageExists, dockerRun } from "../docker/client.ts";
import * as path from "@std/path";

export class DockerBuildStage implements Stage {
  name = "DockerBuildStage";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const imageName = ctx.imageName;

    if (await dockerImageExists(imageName)) {
      console.log(
        `[naw] Docker image "${imageName}" already exists, skipping build`,
      );
    } else {
      console.log(`[naw] Building Docker image "${imageName}"...`);
      const dockerfileDir = path.fromFileUrl(
        new URL("../docker/embed/", import.meta.url),
      );
      await dockerBuild(dockerfileDir, imageName);
    }

    return ctx;
  }
}

export class LaunchStage implements Stage {
  name = "LaunchStage";
  private extraArgs: string[];

  constructor(extraArgs: string[] = []) {
    this.extraArgs = extraArgs;
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const command = [...ctx.agentCommand, ...this.extraArgs];
    console.log(`[naw] Launching container...`);
    console.log(`[naw]   Image: ${ctx.imageName}`);
    console.log(`[naw]   Agent: ${ctx.profile.agent}`);
    console.log(`[naw]   Command: ${command.join(" ")}`);

    await dockerRun({
      image: ctx.imageName,
      args: ctx.dockerArgs,
      envVars: ctx.envVars,
      command,
      interactive: true,
    });

    return ctx;
  }
}
