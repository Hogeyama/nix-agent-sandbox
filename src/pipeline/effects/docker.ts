/**
 * Docker effects: docker-image-build, docker-run-interactive.
 */

import type {
  DockerImageBuildEffect,
  DockerRunInteractiveEffect,
} from "../types.ts";
import type { ResourceHandle } from "./types.ts";
import { dockerBuild, dockerRun } from "../../docker/client.ts";
import * as path from "@std/path";
import { logInfo } from "../../log.ts";

export async function executeDockerImageBuild(
  effect: DockerImageBuildEffect,
): Promise<ResourceHandle> {
  const { imageName, assetGroups, labels } = effect;

  // deno compile 時は仮想FS上のパスになり docker デーモンからアクセスできないため、
  // 埋め込みファイルを一時ディレクトリに書き出してからビルドする
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-docker-build-" });
  try {
    for (const group of assetGroups) {
      for (const name of group.files) {
        const content = await Deno.readTextFile(
          new URL(name, group.baseUrl),
        );
        const outputPath = path.join(tmpDir, group.outputDir, name);
        await Deno.mkdir(path.dirname(outputPath), { recursive: true });
        await Deno.writeTextFile(outputPath, content);
      }
    }
    await dockerBuild(tmpDir, imageName, labels);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch((e) =>
      logInfo(`[nas] DockerBuild: failed to remove temp dir: ${e}`)
    );
  }

  return {
    kind: "docker-image-build",
    close: async () => {
      // Docker images are not cleaned up on teardown —
      // they persist as a cache for subsequent runs.
    },
  };
}

export async function executeDockerRunInteractive(
  effect: DockerRunInteractiveEffect,
): Promise<ResourceHandle> {
  await dockerRun({
    image: effect.image,
    args: effect.args,
    envVars: effect.envVars,
    command: effect.command,
    interactive: true,
    name: effect.name,
    labels: effect.labels,
  });

  return {
    kind: "docker-run-interactive",
    close: async () => {
      // Container runs with --rm, no cleanup needed.
    },
  };
}
