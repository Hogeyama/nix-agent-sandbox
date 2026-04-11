/**
 * Docker イメージビルドステージ (PlanStage)
 *
 * image 存在チェックは probe (resolveBuildProbes)、
 * ビルドは docker-image-build effect。
 */

import {
  computeEmbedHash,
  dockerImageExists,
  getImageLabel,
} from "../docker/client.ts";
import { resolveAssetDir } from "../lib/asset.ts";
import { logInfo, logWarn } from "../log.ts";
import type {
  DockerImageBuildEffect,
  PlanStage,
  StageInput,
  StagePlan,
} from "../pipeline/types.ts";

// ---------------------------------------------------------------------------
// Embedded build asset groups
// ---------------------------------------------------------------------------

const EMBEDDED_BUILD_ASSET_GROUPS = [
  {
    baseDir: resolveAssetDir(
      "docker/embed",
      import.meta.url,
      "../docker/embed/",
    ),
    outputDir: "",
    files: ["Dockerfile", "entrypoint.sh", "osc52-clip.sh", "local-proxy.mjs"],
  },
  {
    baseDir: resolveAssetDir(
      "docker/envoy",
      import.meta.url,
      "../docker/envoy/",
    ),
    outputDir: "envoy",
    files: ["envoy.template.yaml"],
  },
] as const;

// ---------------------------------------------------------------------------
// Build probes
// ---------------------------------------------------------------------------

export interface BuildProbes {
  readonly imageExists: boolean;
  readonly currentEmbedHash: string;
  readonly imageEmbedHash: string | null;
}

export const EMBED_HASH_LABEL = "nas.embed-hash";

/**
 * Resolve build-related probes (I/O). Called once before pipeline starts.
 */
export async function resolveBuildProbes(
  imageName: string,
): Promise<BuildProbes> {
  const [imageExists, currentEmbedHash] = await Promise.all([
    dockerImageExists(imageName),
    computeEmbedHash(),
  ]);

  let imageEmbedHash: string | null = null;
  if (imageExists) {
    imageEmbedHash = await getImageLabel(imageName, EMBED_HASH_LABEL);
  }

  return { imageExists, currentEmbedHash, imageEmbedHash };
}

// ---------------------------------------------------------------------------
// DockerBuildStage (PlanStage)
// ---------------------------------------------------------------------------

export function createDockerBuildStage(buildProbes: BuildProbes): PlanStage {
  return {
    kind: "plan",
    name: "DockerBuildStage",

    plan(input: StageInput): StagePlan | null {
      const imageName = input.prior.imageName;

      if (buildProbes.imageExists) {
        logInfo(
          `[nas] Docker image "${imageName}" already exists, skipping build`,
        );

        if (buildProbes.imageEmbedHash !== buildProbes.currentEmbedHash) {
          logWarn(
            "[nas] \u26a0 Docker image is outdated. Run `nas rebuild` to update.",
          );
        }

        // No effects needed — image already exists
        return {
          effects: [],
          dockerArgs: [],
          envVars: {},
          outputOverrides: {},
        };
      }

      logInfo(`[nas] Building Docker image "${imageName}"...`);

      const buildEffect: DockerImageBuildEffect = {
        kind: "docker-image-build",
        imageName,
        assetGroups: EMBEDDED_BUILD_ASSET_GROUPS,
        labels: {
          [EMBED_HASH_LABEL]: buildProbes.currentEmbedHash,
        },
      };

      return {
        effects: [buildEffect],
        dockerArgs: [],
        envVars: {},
        outputOverrides: {},
      };
    },
  };
}
