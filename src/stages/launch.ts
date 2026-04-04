/**
 * Docker イメージビルド + コンテナ起動ステージ (PlanStage)
 *
 * DockerBuildStage: image 存在チェックは probe (resolveBuildProbes)、
 *   ビルドは docker-image-build effect。
 * LaunchStage: docker-run-interactive effect を返す。
 */

import type {
  DockerImageBuildEffect,
  DockerRunInteractiveEffect,
  PlanStage,
  StageInput,
  StagePlan,
} from "../pipeline/types.ts";
import {
  NAS_KIND_AGENT,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_PWD_LABEL,
} from "../docker/nas_resources.ts";
import {
  computeEmbedHash,
  dockerImageExists,
  getImageLabel,
} from "../docker/client.ts";
import { logInfo, logWarn } from "../log.ts";

// ---------------------------------------------------------------------------
// Embedded build asset groups
// ---------------------------------------------------------------------------

const EMBEDDED_BUILD_ASSET_GROUPS = [
  {
    baseUrl: new URL("../docker/embed/", import.meta.url).href,
    outputDir: "",
    files: ["Dockerfile", "entrypoint.sh", "osc52-clip.sh", "local-proxy.mjs"],
  },
  {
    baseUrl: new URL("../docker/envoy/", import.meta.url).href,
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

export function createDockerBuildStage(
  buildProbes: BuildProbes,
): PlanStage {
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

// ---------------------------------------------------------------------------
// LaunchStage (PlanStage)
// ---------------------------------------------------------------------------

export function createLaunchStage(
  extraArgs: string[] = [],
): PlanStage {
  return {
    kind: "plan",
    name: "LaunchStage",

    plan(input: StageInput): StagePlan | null {
      const command = [
        ...input.prior.agentCommand,
        ...input.profile.agentArgs,
        ...extraArgs,
      ];

      logInfo(`[nas] Launching container...`);
      logInfo(`[nas]   Image: ${input.prior.imageName}`);
      logInfo(`[nas]   Agent: ${input.profile.agent}`);
      logInfo(`[nas]   Command: ${command.join(" ")}`);

      const runEffect: DockerRunInteractiveEffect = {
        kind: "docker-run-interactive",
        image: input.prior.imageName,
        name: `nas-agent-${input.sessionId}`,
        args: [...input.prior.dockerArgs],
        envVars: { ...input.prior.envVars },
        command,
        labels: {
          [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
          [NAS_KIND_LABEL]: NAS_KIND_AGENT,
          [NAS_PWD_LABEL]: input.prior.workDir,
        },
      };

      return {
        effects: [runEffect],
        dockerArgs: [],
        envVars: {},
        outputOverrides: {},
      };
    },
  };
}
