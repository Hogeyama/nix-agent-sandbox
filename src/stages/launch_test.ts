import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  StageInput,
} from "../pipeline/types.ts";
import {
  type LaunchOpts,
  makeContainerLaunchServiceFake,
} from "../services/container_launch.ts";
import type { ContainerPlan, PipelineState } from "../pipeline/state.ts";
import { compileLaunchOpts, createLaunchStage, planLaunch } from "./launch.ts";

test("planLaunch: produces correct plan with composed command", () => {
  const input = createTestInput({
    imageName: "custom-image",
    agentCommand: ["agent-bin", "serve"],
    dockerArgs: ["--network", "sandbox-net", "-v", "/tmp:/workspace"],
    envVars: { TOKEN: "secret", MODE: "test" },
  });
  input.profile.agentArgs = ["--profile-arg"];

  const plan = planLaunch(input, ["--user-arg"]);

  expect(plan.container.image).toEqual("custom-image");
  expect(plan.opts.args).toEqual([
    "-w",
    "/workspace",
    "-v",
    "/tmp:/workspace",
    "--network",
    "sandbox-net",
  ]);
  expect(plan.container.env.static).toEqual({ TOKEN: "secret", MODE: "test" });
  expect(plan.opts.command).toEqual([
    "agent-bin",
    "serve",
    "--profile-arg",
    "--user-arg",
  ]);
  expect(plan.containerName.startsWith("nas-agent-")).toEqual(true);
});

test("planLaunch: composes launch opts from prior container slice", () => {
  const input = createTestInput({
    imageName: "legacy-image",
    workDir: "/legacy-workdir",
    dockerArgs: ["--rm"],
    envVars: { LEGACY: "1" },
    agentCommand: ["legacy-agent"],
    container: {
      image: "slice-image",
      workDir: "/slice-workdir",
      mounts: [{ source: "/repo", target: "/workspace" }],
      env: {
        static: { FROM_SLICE: "yes" },
        dynamicOps: [],
      },
      network: { name: "slice-net", alias: "slice-agent" },
      extraRunArgs: ["--init"],
      command: {
        agentCommand: ["slice-agent"],
        extraArgs: ["--safe"],
      },
      labels: { "existing.label": "kept" },
    },
  });
  input.profile.agentArgs = ["--profile"];

  const plan = planLaunch(input, ["--cli"]);

  expect(plan.container.image).toEqual("slice-image");
  expect(plan.opts.args).toEqual([
    "-w",
    "/slice-workdir",
    "-v",
    "/repo:/workspace",
    "--network",
    "slice-net",
    "--network-alias",
    "slice-agent",
    "--init",
  ]);
  expect(plan.opts.envVars).toEqual({ FROM_SLICE: "yes" });
  expect(plan.opts.command).toEqual([
    "slice-agent",
    "--safe",
    "--profile",
    "--cli",
  ]);
  expect(plan.opts.labels).toEqual({
    "existing.label": "kept",
    "nas.managed": "true",
    "nas.kind": "agent",
    "nas.pwd": "/slice-workdir",
    "nas.session_id": "sess_test123",
  });
});

test("planLaunch: legacy fallback parses structured dockerArgs without duplicating -w", () => {
  const input = createTestInput({
    imageName: "legacy-image",
    workDir: "/legacy-default",
    dockerArgs: [
      "-w",
      "/legacy-workdir",
      "--network",
      "legacy-net",
      "--rm",
    ],
    envVars: { LEGACY: "1" },
    agentCommand: ["legacy-agent"],
  });
  input.profile.agentArgs = ["--profile"];

  const plan = planLaunch(input, ["--cli"]);

  expect(plan.container.workDir).toEqual("/legacy-workdir");
  expect(plan.container.network).toEqual({ name: "legacy-net", alias: undefined });
  expect(plan.opts.args).toEqual([
    "-w",
    "/legacy-workdir",
    "--network",
    "legacy-net",
    "--rm",
  ]);
  expect(plan.opts.command).toEqual(["legacy-agent", "--profile", "--cli"]);
});

test("LaunchStage: run() calls ContainerLaunchService.launch", async () => {
  let capturedOpts: LaunchOpts | undefined;

  const fakeLayer = makeContainerLaunchServiceFake({
    launch: (opts) => {
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
  expect(capturedOpts!.args).toEqual(["-w", "/workspace", "-v", "/src:/work"]);
  expect(capturedOpts!.envVars).toEqual({ KEY: "val" });
  expect(capturedOpts!.name!.startsWith("nas-agent-")).toEqual(true);
});

function makeBasePlan(overrides?: Partial<ContainerPlan>): ContainerPlan {
  return {
    image: "nas-sandbox:latest",
    workDir: "/workspace/project",
    mounts: [],
    env: { static: {}, dynamicOps: [] },
    extraRunArgs: [],
    command: { agentCommand: ["claude"], extraArgs: [] },
    labels: {},
    ...overrides,
  };
}

test("compileLaunchOpts: baseline plan produces correct LaunchOpts", () => {
  const plan = makeBasePlan({
    image: "nas-sandbox:test",
    workDir: "/workspace",
    env: { static: { TOKEN: "abc", MODE: "test" }, dynamicOps: [] },
    command: { agentCommand: ["claude", "serve"], extraArgs: ["--fast"] },
    labels: { "nas.managed": "true" },
  });

  const opts = compileLaunchOpts(plan, "nas-agent-sess1");

  expect(opts.image).toEqual("nas-sandbox:test");
  expect(opts.name).toEqual("nas-agent-sess1");
  expect(opts.args).toEqual(["-w", "/workspace"]);
  expect(opts.envVars).toEqual({ TOKEN: "abc", MODE: "test" });
  expect(opts.command).toEqual(["claude", "serve", "--fast"]);
  expect(opts.labels).toEqual({ "nas.managed": "true" });
});

test("compileLaunchOpts: mounts encoded as -v args in order", () => {
  const plan = makeBasePlan({
    mounts: [
      { source: "/src", target: "/work" },
      { source: "/nix", target: "/nix", readOnly: true },
      { source: "/cfg", target: "/etc/cfg", readOnly: false },
    ],
  });

  const opts = compileLaunchOpts(plan, "nas-agent-x");

  expect(opts.args).toContain("-v");
  const vArgs: string[] = [];
  for (let i = 0; i < opts.args.length; i++) {
    if (opts.args[i] === "-v") vArgs.push(opts.args[i + 1]);
  }
  expect(vArgs).toEqual(["/src:/work", "/nix:/nix:ro", "/cfg:/etc/cfg"]);
});

test("compileLaunchOpts: dynamic env ops are encoded into NAS_ENV_OPS", () => {
  const plan = makeBasePlan({
    env: {
      static: { EXISTING: "val" },
      dynamicOps: [
        { mode: "prefix", key: "PATH", value: "/usr/local/bin", separator: ":" },
        { mode: "suffix", key: "MANPATH", value: "/man", separator: ":" },
      ],
    },
  });

  const opts = compileLaunchOpts(plan, "nas-agent-y");

  expect(opts.envVars.EXISTING).toEqual("val");
  expect(opts.envVars.NAS_ENV_OPS).toContain("__nas_pfx");
  expect(opts.envVars.NAS_ENV_OPS).toContain("__nas_sfx");
  expect(opts.envVars.NAS_ENV_OPS).toContain("PATH");
  expect(opts.envVars.NAS_ENV_OPS).toContain("MANPATH");
});

test("compileLaunchOpts: no dynamic ops → NAS_ENV_OPS absent", () => {
  const plan = makeBasePlan({
    env: { static: { FOO: "bar" }, dynamicOps: [] },
  });

  const opts = compileLaunchOpts(plan, "nas-agent-z");

  expect("NAS_ENV_OPS" in opts.envVars).toEqual(false);
});

test("compileLaunchOpts: network attachment adds --network and optional --network-alias", () => {
  const planNoAlias = makeBasePlan({
    network: { name: "sandbox-net" },
  });
  const optsNoAlias = compileLaunchOpts(planNoAlias, "nas-agent-1");
  expect(optsNoAlias.args).toContain("--network");
  expect(optsNoAlias.args[optsNoAlias.args.indexOf("--network") + 1]).toEqual(
    "sandbox-net",
  );
  expect(optsNoAlias.args).not.toContain("--network-alias");

  const planWithAlias = makeBasePlan({
    network: { name: "sandbox-net", alias: "agent" },
  });
  const optsWithAlias = compileLaunchOpts(planWithAlias, "nas-agent-2");
  expect(optsWithAlias.args).toContain("--network-alias");
  expect(
    optsWithAlias.args[optsWithAlias.args.indexOf("--network-alias") + 1],
  ).toEqual("agent");
});

test("compileLaunchOpts: extraRunArgs appended after network args", () => {
  const plan = makeBasePlan({
    network: { name: "net1" },
    extraRunArgs: ["--shm-size", "2g", "--privileged"],
  });

  const opts = compileLaunchOpts(plan, "nas-agent-3");

  const networkIdx = opts.args.indexOf("--network");
  const shmIdx = opts.args.indexOf("--shm-size");
  expect(shmIdx).toBeGreaterThan(networkIdx);
  expect(opts.args).toContain("--privileged");
});

test("compileLaunchOpts: mounts + env + network combined (mixed parity)", () => {
  const plan: ContainerPlan = {
    image: "nas-sandbox:mixed",
    workDir: "/ws",
    mounts: [
      { source: "/repo", target: "/repo" },
      { source: "/nix", target: "/nix", readOnly: true },
    ],
    env: {
      static: { NAS_USER: "alice", NAS_HOME: "/home/alice" },
      dynamicOps: [
        { mode: "prefix", key: "PATH", value: "/home/alice/.local/bin", separator: ":" },
      ],
    },
    network: { name: "nas-proxy-net", alias: "nas-agent" },
    extraRunArgs: ["--shm-size", "2g"],
    command: { agentCommand: ["copilot", "run"], extraArgs: ["--verbose"] },
    labels: { "nas.managed": "true", "nas.kind": "agent" },
  };

  const opts = compileLaunchOpts(plan, "nas-agent-mixed");

  expect(opts.image).toEqual("nas-sandbox:mixed");
  expect(opts.name).toEqual("nas-agent-mixed");
  expect(opts.envVars.NAS_USER).toEqual("alice");
  expect(opts.envVars.NAS_ENV_OPS).toContain("__nas_pfx");
  expect(opts.command).toEqual(["copilot", "run", "--verbose"]);

  const wIdx = opts.args.indexOf("-w");
  const firstVIdx = opts.args.indexOf("-v");
  const netIdx = opts.args.indexOf("--network");
  const shmIdx = opts.args.indexOf("--shm-size");
  expect(wIdx).toBeLessThan(firstVIdx);
  expect(firstVIdx).toBeLessThan(netIdx);
  expect(netIdx).toBeLessThan(shmIdx);
});

function createTestInput(
  priorOverrides: Partial<PriorStageOutputs & Partial<PipelineState>> = {},
): StageInput & { profile: Profile } {
  const profile: Profile = {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
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
