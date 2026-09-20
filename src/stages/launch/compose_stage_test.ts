import { expect, test } from "bun:test";
import type { DevcontainerRegistration } from "../../domain/devcontainer.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { finalizeDevcontainerPlan } from "./compose_stage.ts";

const registration: DevcontainerRegistration = {
  version: 1,
  workspaceId: "a".repeat(64),
  workspace: "/repo",
  profileName: "claude",
  agent: "claude",
  configPath: "/repo/.devcontainer/devcontainer.json",
  composePath: "/state/compose.json",
  stateRoot: "/state/workspace",
  command: ["nas"],
};

const container: ContainerPlan = {
  image: "nas-sandbox",
  workDir: "/repo",
  mounts: [],
  env: {
    static: {},
    dynamicOps: [
      { mode: "prefix", key: "PATH", value: "/one", separator: ":" },
      { mode: "suffix", key: "PATH", value: "/two", separator: ":" },
      { mode: "prefix", key: "X", value: "$literal", separator: ":" },
    ],
  },
  network: { mode: "network", name: "nas-net" },
  extraHosts: [],
  namedVolumes: [],
  extraRunArgs: [],
  command: { agentCommand: ["claude"], extraArgs: ["already"] },
  labels: {},
};

const input = {
  profile: { agentArgs: ["profile"] },
  profileName: "claude",
  sessionId: "sess-1",
} as StageInput;

test("IDE finalization adds lookup labels and applies each argv/env operation once", () => {
  const result = finalizeDevcontainerPlan(input, container, {
    registration,
    agentExtraArgs: ["$explicit"],
  });
  expect(result.container.labels).toMatchObject({
    "devcontainer.local_folder": "/repo",
    "devcontainer.config_file": registration.configPath,
    "nas.session_id": "sess-1",
  });
  expect(result.container.command.extraArgs).toEqual([
    "already",
    "profile",
    "$explicit",
  ]);
  expect(result.container.env.static).toMatchObject({
    NAS_DEVCONTAINER: "true",
    NAS_DEVCONTAINER_ENV_KEYS: "PATH X",
  });
  expect(result.container.env.dynamicOps).toEqual(container.env.dynamicOps);
});

test("codex devcontainer keeps only -c pairs from profile agentArgs", () => {
  const codexInput = {
    ...input,
    profile: {
      agent: "codex",
      agentArgs: ["-c", "model=o4-mini", "--yolo", "prompt"],
    },
  } as StageInput;
  const result = finalizeDevcontainerPlan(codexInput, container, {
    registration,
  });
  expect(result.container.command.extraArgs).toEqual([
    "already",
    "-c",
    "model=o4-mini",
  ]);
});
