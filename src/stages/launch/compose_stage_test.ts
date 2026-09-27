import { expect, test } from "bun:test";
import type { DevcontainerRegistration } from "../../domain/devcontainer.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { HostEnv, StageInput } from "../../pipeline/types.ts";
import { compileCompose } from "./compose.ts";
import { finalizeDevcontainerPlan } from "./compose_stage.ts";

const host: HostEnv = {
  home: "/home/tester",
  user: "tester",
  uid: 1000,
  gid: 1000,
  isWSL: false,
  env: new Map(),
};

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
  profile: { agent: "claude", agentArgs: ["profile"], extraAgents: [] },
  profileName: "claude",
  sessionId: "sess-1",
  host,
} as unknown as StageInput;

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
    NAS_DEVCONTAINER_PRIMARY_AGENT: "claude",
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
      extraAgents: [],
    },
  } as unknown as StageInput;
  const result = finalizeDevcontainerPlan(codexInput, container, {
    registration,
  });
  expect(result.container.command.extraArgs).toEqual([
    "already",
    "-c",
    "model=o4-mini",
  ]);
  expect(result.container.env.static.NAS_DEVCONTAINER_PRIMARY_AGENT).toBe(
    "codex",
  );
});

test("IDE finalization's metadata label reflects the current profile, not the stored registration's agent", () => {
  // `registration.agent` is "claude" (see above), but the *current* profile
  // carries a primary Codex with an extra Claude — this is exactly the case
  // a profile change after init must still produce correct metadata for.
  const changedInput = {
    ...input,
    profile: {
      agent: "codex",
      agentArgs: [],
      extraAgents: ["claude"],
    },
  } as unknown as StageInput;
  const result = finalizeDevcontainerPlan(changedInput, container, {
    registration,
  });
  const metadata = JSON.parse(result.container.labels["devcontainer.metadata"]);
  expect(metadata).toEqual([
    {
      remoteUser: "tester",
      updateRemoteUserUID: false,
      overrideCommand: false,
      userEnvProbe: "loginInteractiveShell",
      shutdownAction: "none",
      customizations: {
        vscode: {
          extensions: ["anthropic.claude-code", "openai.chatgpt"],
          settings: {
            "claudeCode.claudeProcessWrapper":
              "/usr/local/bin/nas-devcontainer-claude",
            "chatgpt.cliExecutable": "/usr/local/bin/nas-devcontainer-codex",
          },
        },
      },
    },
  ]);
  expect(result.container.labels).toMatchObject({
    "devcontainer.local_folder": "/repo",
    "devcontainer.config_file": registration.configPath,
    "nas.session_id": "sess-1",
  });
  expect(result.container.env.static.NAS_DEVCONTAINER_PRIMARY_AGENT).toBe(
    "codex",
  );
  const compose = compileCompose(
    result.container,
    result.containerName,
    "nas-project",
  );
  expect(compose.services.agent.labels).toEqual(result.container.labels);
});
