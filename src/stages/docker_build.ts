/**
 * Docker イメージビルドステージ (EffectStage)
 *
 * image 存在チェックは probe (resolveBuildProbes)、
 * ビルドは DockerService.build。
 */

import { Effect, type Scope } from "effect";
import {
  computeEmbedHash,
  dockerImageExists,
  getImageLabel,
} from "../docker/client.ts";
import { resolveAssetDir } from "../lib/asset.ts";
import { logInfo, logWarn } from "../log.ts";
import type { Stage } from "../pipeline/stage_builder.ts";
import type { WorkspaceState } from "../pipeline/state.ts";
import { DockerBuildService } from "../services/docker_build.ts";

// ---------------------------------------------------------------------------
// Embedded build asset groups
// ---------------------------------------------------------------------------

export interface EmbeddedAssetGroup {
  readonly baseDir: string;
  readonly outputDir: string;
  readonly files: readonly string[];
}

export const EMBEDDED_BUILD_ASSET_GROUPS: readonly EmbeddedAssetGroup[] = [
  {
    baseDir: resolveAssetDir(
      "docker/embed",
      import.meta.url,
      "../docker/embed/",
    ),
    outputDir: "",
    files: ["Dockerfile", "entrypoint.sh", "local-proxy.mjs"],
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
  readonly imageName: string;
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

  return { imageName, imageExists, currentEmbedHash, imageEmbedHash };
}

// ---------------------------------------------------------------------------
// DockerBuildPlan
// ---------------------------------------------------------------------------

export interface DockerBuildPlan {
  readonly needsBuild: boolean;
  readonly imageName: string;
  readonly assetGroups: readonly EmbeddedAssetGroup[];
  readonly labels: Record<string, string>;
}

function resolveWorkspace(input: {
  workspace: WorkspaceState;
}): WorkspaceState {
  return input.workspace;
}

export function planDockerBuild(
  input: { workspace: WorkspaceState },
  buildProbes: BuildProbes,
): DockerBuildPlan {
  const { imageName } = resolveWorkspace(input);

  if (buildProbes.imageName !== imageName) {
    throw new Error(
      `[nas] DockerBuildStage probe/image mismatch: probes=${buildProbes.imageName} workspace=${imageName}`,
    );
  }

  if (buildProbes.imageExists) {
    if (buildProbes.imageEmbedHash === buildProbes.currentEmbedHash) {
      logInfo(
        `[nas] Docker image "${imageName}" already exists, skipping build`,
      );
      return {
        needsBuild: false,
        imageName,
        assetGroups: [],
        labels: {},
      };
    }

    logWarn(`[nas] Docker image "${imageName}" is outdated, rebuilding...`);
    return {
      needsBuild: true,
      imageName,
      assetGroups: EMBEDDED_BUILD_ASSET_GROUPS,
      labels: {
        [EMBED_HASH_LABEL]: buildProbes.currentEmbedHash,
      },
    };
  }

  logInfo(`[nas] Building Docker image "${imageName}"...`);

  return {
    needsBuild: true,
    imageName,
    assetGroups: EMBEDDED_BUILD_ASSET_GROUPS,
    labels: {
      [EMBED_HASH_LABEL]: buildProbes.currentEmbedHash,
    },
  };
}

// ---------------------------------------------------------------------------
// DockerBuildStage (EffectStage<DockerBuildService>)
// ---------------------------------------------------------------------------

export function createDockerBuildStage(
  buildProbes: BuildProbes,
): Stage<"workspace", {}, DockerBuildService, unknown> {
  return {
    name: "DockerBuildStage",
    needs: ["workspace"],

    run(input): Effect.Effect<{}, unknown, DockerBuildService | Scope.Scope> {
      const plan = planDockerBuild(input, buildProbes);

      if (!plan.needsBuild) {
        return Effect.succeed({});
      }

      return Effect.gen(function* () {
        const dockerBuild = yield* DockerBuildService;
        yield* dockerBuild.buildImage({
          assetGroups: plan.assetGroups,
          imageName: plan.imageName,
          labels: plan.labels,
        });
        return {};
      });
    },
  };
}
