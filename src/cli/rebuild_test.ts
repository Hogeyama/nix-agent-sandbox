import { expect, test } from "bun:test";
import type { BuildProbes } from "../stages/docker_build.ts";
import {
  createRebuildInitialState,
  createRebuildPipelineBuilder,
} from "./rebuild.ts";

test("createRebuildInitialState: seeds workspace and container slices", () => {
  const initialState = createRebuildInitialState(
    "/repo/worktree",
    "nas-sandbox",
  );

  expect(initialState.workspace).toEqual({
    workDir: "/repo/worktree",
    imageName: "nas-sandbox",
  });
  expect(initialState.container).toEqual({
    image: "nas-sandbox",
    workDir: "/repo/worktree",
    mounts: [],
    env: { static: {}, dynamicOps: [] },
    extraRunArgs: [],
    command: { agentCommand: [], extraArgs: [] },
    labels: {},
  });
});

test("createRebuildPipelineBuilder: runs docker build through workspace-gated state stage", () => {
  const buildProbes: BuildProbes = {
    imageName: "nas-sandbox",
    imageExists: false,
    currentEmbedHash: "embed-hash",
    imageEmbedHash: null,
  };

  const builder = createRebuildPipelineBuilder({
    buildProbes,
  });

  expect(builder.getStages()).toHaveLength(1);
  expect(builder.getStages()[0]).toMatchObject({
    name: "DockerBuildStage",
    needs: ["workspace"],
  });
});
