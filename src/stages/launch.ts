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
import {
  NAS_KIND_AGENT,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../docker/nas_resources.ts";
import * as path from "@std/path";
import { logInfo, logWarn } from "../log.ts";

const EMBEDDED_BUILD_ASSET_GROUPS = [
  {
    baseUrl: new URL("../docker/embed/", import.meta.url),
    outputDir: "",
    files: ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"],
  },
  {
    baseUrl: new URL("../docker/envoy/", import.meta.url),
    outputDir: "envoy",
    files: ["envoy.template.yaml"],
  },
] as const;

export class DockerBuildStage implements Stage {
  name = "DockerBuildStage";

  static readonly EMBED_HASH_LABEL = "nas.embed-hash";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const imageName = ctx.imageName;

    if (await dockerImageExists(imageName)) {
      logInfo(
        `[nas] Docker image "${imageName}" already exists, skipping build`,
      );

      // Check if the embedded files have changed since the image was built
      const currentHash = await computeEmbedHash();
      const imageHash = await getImageLabel(
        imageName,
        DockerBuildStage.EMBED_HASH_LABEL,
      );
      if (imageHash !== currentHash) {
        logWarn(
          "[nas] \u26a0 Docker image is outdated. Run `nas rebuild` to update.",
        );
      }
    } else {
      logInfo(`[nas] Building Docker image "${imageName}"...`);
      const embedHash = await computeEmbedHash();
      // deno compile 時は仮想FS上のパスになり docker デーモンからアクセスできないため、
      // 埋め込みファイルを一時ディレクトリに書き出してからビルドする
      const tmpDir = await Deno.makeTempDir({ prefix: "nas-docker-build-" });
      try {
        for (const group of EMBEDDED_BUILD_ASSET_GROUPS) {
          for (const name of group.files) {
            const content = await Deno.readTextFile(
              new URL(name, group.baseUrl),
            );
            const outputPath = path.join(tmpDir, group.outputDir, name);
            await Deno.mkdir(path.dirname(outputPath), { recursive: true });
            await Deno.writeTextFile(outputPath, content);
          }
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
    logInfo(`[nas] Launching container...`);
    logInfo(`[nas]   Image: ${ctx.imageName}`);
    logInfo(`[nas]   Agent: ${ctx.profile.agent}`);
    logInfo(`[nas]   Command: ${command.join(" ")}`);

    await dockerRun({
      image: ctx.imageName,
      args: ctx.dockerArgs,
      envVars: ctx.envVars,
      command,
      interactive: true,
      name: `nas-agent-${ctx.sessionId}`,
      labels: {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_AGENT,
      },
    });

    return ctx;
  }
}
