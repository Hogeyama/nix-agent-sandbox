/**
 * Docker イメージビルド + コンテナ起動ステージ
 */

import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import {
  computeEmbedHash,
  dockerBuild,
  dockerImageExists,
  dockerRun,
  getImageLabel,
} from "../docker/client.ts";
import * as path from "@std/path";

export class DockerBuildStage implements Stage {
  name = "DockerBuildStage";

  static readonly EMBED_HASH_LABEL = "nas.embed-hash";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const imageName = ctx.imageName;

    if (await dockerImageExists(imageName)) {
      console.log(
        `[nas] Docker image "${imageName}" already exists, skipping build`,
      );

      // Check if the embedded files have changed since the image was built
      const currentHash = await computeEmbedHash();
      const imageHash = await getImageLabel(
        imageName,
        DockerBuildStage.EMBED_HASH_LABEL,
      );
      if (imageHash !== currentHash) {
        console.log(
          "[nas] \u26a0 Docker image is outdated. Run `nas rebuild` to update.",
        );
      }
    } else {
      console.log(`[nas] Building Docker image "${imageName}"...`);
      const embedHash = await computeEmbedHash();
      // deno compile 時は仮想FS上のパスになり docker デーモンからアクセスできないため、
      // 埋め込みファイルを一時ディレクトリに書き出してからビルドする
      const tmpDir = await Deno.makeTempDir({ prefix: "nas-docker-build-" });
      try {
        const baseUrl = new URL("../docker/embed/", import.meta.url);
        for (const name of ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"]) {
          const content = await Deno.readTextFile(new URL(name, baseUrl));
          await Deno.writeTextFile(path.join(tmpDir, name), content);
        }
        await dockerBuild(tmpDir, imageName, {
          [DockerBuildStage.EMBED_HASH_LABEL]: embedHash,
        });
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
    const command = [
      ...ctx.agentCommand,
      ...ctx.profile.agentArgs,
      ...this.extraArgs,
    ];
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
