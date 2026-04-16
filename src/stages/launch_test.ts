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
import { emptyContainerPlan } from "../pipeline/container_plan.ts";
import type { ContainerPlan } from "../pipeline/state.ts";
import type { HostEnv, StageInput } from "../pipeline/types.ts";
import {
  type LaunchOpts,
  makeContainerLaunchServiceFake,
} from "../services/container_launch.ts";
import { compileLaunchOpts, createLaunchStage, planLaunch } from "./launch.ts";

test("planLaunch: produces correct plan with composed command", () => {
  const { input, container } = createTestInput({
    container: {
      ...emptyContainerPlan("custom-image", "/workspace"),
      mounts: [{ source: "/tmp", target: "/workspace" }],
      env: { static: { TOKEN: "secret", MODE: "test" }, dynamicOps: [] },
      network: { name: "sandbox-net" },
      command: { agentCommand: ["agent-bin", "serve"], extraArgs: [] },
    },
  });
  input.profile.agentArgs = ["--profile-arg"];

  const plan = planLaunch({ ...input, container }, ["--user-arg"]);

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

test("planLaunch: composes launch opts from container slice", () => {
  const { input, container } = createTestInput({
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

  const plan = planLaunch({ ...input, container }, ["--cli"]);

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

test("planLaunch: slice contract keeps workdir/network/mounts singular in launch args", () => {
  const workDir = "/slice-workdir";
  const mounts = [
    { source: "/repo", target: "/workspace" },
    { source: "/nix", target: "/nix", readOnly: true as const },
  ];
  const network = { name: "slice-net", alias: "slice-agent" };
  const { input, container } = createTestInput({
    container: {
      image: "slice-image",
      workDir,
      mounts,
      env: { static: {}, dynamicOps: [] },
      network,
      extraRunArgs: ["--init", "--cpus", "2"],
      command: { agentCommand: ["slice-agent"], extraArgs: [] },
      labels: {},
    },
  });

  const plan = planLaunch({ ...input, container }, []);
  const args = plan.opts.args;

  expect(args.filter((arg) => arg === "-w")).toHaveLength(1);
  expect(args[args.indexOf("-w") + 1]).toEqual(workDir);

  expect(args.filter((arg) => arg === "--network")).toHaveLength(1);
  expect(args[args.indexOf("--network") + 1]).toEqual(network.name);

  const encodedMounts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v") encodedMounts.push(args[i + 1]);
  }
  expect(encodedMounts).toEqual(["/repo:/workspace", "/nix:/nix:ro"]);
});

test("LaunchStage: run() calls ContainerLaunchService.launch", async () => {
  let capturedOpts: LaunchOpts | undefined;

  const fakeLayer = makeContainerLaunchServiceFake({
    launch: (opts) => {
      capturedOpts = opts;
      return Effect.void;
    },
  });

  const { input, container } = createTestInput({
    container: {
      ...emptyContainerPlan("test-image", "/workspace"),
      mounts: [{ source: "/src", target: "/work" }],
      env: { static: { KEY: "val" }, dynamicOps: [] },
      command: { agentCommand: ["claude"], extraArgs: [] },
    },
  });
  input.profile.agentArgs = ["--fast"];

  const stage = createLaunchStage(input, ["--extra"]);
  const effect = stage
    .run({ container })
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
        {
          mode: "prefix",
          key: "PATH",
          value: "/usr/local/bin",
          separator: ":",
        },
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
        {
          mode: "prefix",
          key: "PATH",
          value: "/home/alice/.local/bin",
          separator: ":",
        },
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

function createTestInput(overrides: { container?: ContainerPlan } = {}): {
  input: StageInput & { profile: Profile };
  container: ContainerPlan;
} {
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
  const container =
    overrides.container ?? emptyContainerPlan("nas-sandbox", "/workspace");
  return {
    input: {
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
    },
    container,
  };
}
