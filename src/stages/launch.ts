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
        `[nas] Docker image "${imageName}" already exists, skipping build`,
      );
    } else {
      console.log(`[nas] Building Docker image "${imageName}"...`);
      // deno compile 時は仮想FS上のパスになり docker デーモンからアクセスできないため、
      // 埋め込みファイルを一時ディレクトリに書き出してからビルドする
      const tmpDir = await Deno.makeTempDir({ prefix: "nas-docker-build-" });
      try {
        const baseUrl = new URL("../docker/embed/", import.meta.url);
        for (const name of ["Dockerfile", "entrypoint.sh"]) {
          const content = await Deno.readTextFile(new URL(name, baseUrl));
          await Deno.writeTextFile(path.join(tmpDir, name), content);
        }
        await dockerBuild(tmpDir, imageName);
      } finally {
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
      }
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
    const command = [...ctx.agentCommand, ...ctx.profile.agentArgs, ...this.extraArgs];
    console.log(`[nas] Launching container...`);
    console.log(`[nas]   Image: ${ctx.imageName}`);
    console.log(`[nas]   Agent: ${ctx.profile.agent}`);
    console.log(`[nas]   Command: ${command.join(" ")}`);

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
