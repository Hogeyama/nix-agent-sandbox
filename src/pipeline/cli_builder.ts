import { createDbusProxyStage } from "../stages/dbus_proxy.ts";
import { createDindStage } from "../stages/dind.ts";
import { createDisplayStage } from "../stages/display.ts";
import {
  type BuildProbes,
  createDockerBuildStage,
} from "../stages/docker_build.ts";
import { createGuideStage } from "../stages/guide.ts";
import { createHostExecStage } from "../stages/hostexec.ts";
import { createLaunchStage } from "../stages/launch.ts";
import { createMaskFilterStage, createMaskFsStage } from "../stages/maskfs.ts";
import type { DevcontainerMountInput } from "../stages/mount.ts";
import { createMountStage, type MountProbes } from "../stages/mount.ts";
import { createNixDetectStage } from "../stages/nix_detect.ts";
import { createObservabilityStage } from "../stages/observability.ts";
import { createPortBindStage } from "../stages/port_bind.ts";
import { createProxyStage } from "../stages/proxy.ts";
import { createSessionStoreStage } from "../stages/session_store.ts";
import { createWorktreeStage } from "../stages/worktree.ts";
import { createPipelineBuilder } from "./stage_builder.ts";
import type { PipelineState } from "./state.ts";
import type { StageInput } from "./types.ts";

export interface PreparationPipelineOptions {
  readonly input: StageInput;
  readonly buildProbes: BuildProbes;
  readonly mountProbes: MountProbes;
  readonly devcontainerMounts?: DevcontainerMountInput;
}

/** Shared preparation order. Application adapters select only the final launch stage. */
export function createPreparationPipelineBuilder({
  input,
  buildProbes,
  mountProbes,
  devcontainerMounts,
}: PreparationPipelineOptions) {
  return createPipelineBuilder<Pick<PipelineState, "workspace" | "container">>()
    .add(createWorktreeStage(input))
    .add(createSessionStoreStage(input))
    .add(createDockerBuildStage(buildProbes))
    .add(createNixDetectStage(input))
    .add(createDbusProxyStage(input))
    .add(createDisplayStage(input, mountProbes))
    .add(createMaskFsStage(input, mountProbes))
    .add(createMountStage(input, mountProbes, devcontainerMounts))
    .add(createMaskFilterStage(input))
    .add(createHostExecStage(input))
    .add(createGuideStage(input))
    .add(
      createObservabilityStage({
        config: input.config,
        profile: input.profile,
        profileName: input.profileName,
        sessionId: input.sessionId,
        devcontainer: devcontainerMounts !== undefined,
      }),
    )
    .add(
      createProxyStage(input, {
        devcontainer: devcontainerMounts !== undefined,
      }),
    )
    .add(createDindStage(input))
    .add(createPortBindStage(input));
}

export function createCliPipelineBuilder(
  options: PreparationPipelineOptions & { readonly agentExtraArgs: string[] },
) {
  return createPreparationPipelineBuilder(options).add(
    createLaunchStage(options.input, options.agentExtraArgs),
  );
}
