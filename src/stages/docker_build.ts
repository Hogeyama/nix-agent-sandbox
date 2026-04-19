/**
 * docker_build ステージ — barrel re-export
 */

export {
  type DockerBuildImagePlan,
  DockerBuildService,
  type DockerBuildServiceFakeConfig,
  DockerBuildServiceLive,
  makeDockerBuildServiceFake,
} from "./docker_build/docker_build_service.ts";
export {
  type BuildProbes,
  createDockerBuildStage,
  type DockerBuildPlan,
  EMBED_HASH_LABEL,
  EMBEDDED_BUILD_ASSET_GROUPS,
  type EmbeddedAssetGroup,
  planDockerBuild,
  resolveBuildProbes,
} from "./docker_build/stage.ts";
