import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  StageInput,
} from "../pipeline/types.ts";
import {
  type DockerRunOpts,
  makeDockerServiceFake,
} from "../services/docker.ts";
import { createLaunchStage, planLaunch } from "./launch.ts";

test("planLaunch: produces correct plan with composed command", () => {
  const input = createTestInput({
    imageName: "custom-image",
    agentCommand: ["agent-bin", "serve"],
    dockerArgs: ["--network", "sandbox-net", "-v", "/tmp:/workspace"],
    envVars: { TOKEN: "secret", MODE: "test" },
  });
  input.profile.agentArgs = ["--profile-arg"];

  const plan = planLaunch(input, ["--user-arg"]);

  expect(plan.image).toEqual("custom-image");
  expect(plan.args).toEqual([
    "--network",
    "sandbox-net",
    "-v",
    "/tmp:/workspace",
  ]);
  expect(plan.envVars).toEqual({ TOKEN: "secret", MODE: "test" });
  expect(plan.command).toEqual([
    "agent-bin",
    "serve",
    "--profile-arg",
    "--user-arg",
  ]);
  expect(plan.containerName.startsWith("nas-agent-")).toEqual(true);
});

test("LaunchStage: run() calls DockerService.runInteractive", async () => {
  let capturedOpts: DockerRunOpts | undefined;

  const fakeLayer = makeDockerServiceFake({
    runInteractive: (opts) => {
      capturedOpts = opts;
      return Effect.void;
    },
  });

  const stage = createLaunchStage(["--extra"]);
  const input = createTestInput({
    imageName: "test-image",
    agentCommand: ["claude"],
    dockerArgs: ["-v", "/src:/work"],
    envVars: { KEY: "val" },
  });
  input.profile.agentArgs = ["--fast"];

  const effect = stage
    .run(input)
    .pipe(Effect.scoped, Effect.provide(fakeLayer));

  const result = await Effect.runPromise(effect);

  expect(result).toEqual({});
  expect(capturedOpts).toBeDefined();
  expect(capturedOpts!.image).toEqual("test-image");
  expect(capturedOpts!.command).toEqual(["claude", "--fast", "--extra"]);
  expect(capturedOpts!.args).toEqual(["-v", "/src:/work"]);
  expect(capturedOpts!.envVars).toEqual({ KEY: "val" });
  expect(capturedOpts!.name!.startsWith("nas-agent-")).toEqual(true);
});

function createTestInput(
  priorOverrides: Partial<PriorStageOutputs> = {},
): StageInput & { profile: Profile } {
  const profile: Profile = {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
  };
  const config: Config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const host: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  };
  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: {},
    workDir: "/workspace",
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...priorOverrides,
  };
  return {
    config,
    profile,
    profileName: "test",
    sessionId: "sess_test123",
    host,
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/audit",
    },
    prior,
  };
}
