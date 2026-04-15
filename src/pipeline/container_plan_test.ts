import { expect, test } from "bun:test";
import {
  type ContainerPatch,
  compileLaunchOpts,
  emptyContainerPlan,
  mergeContainerPlan,
} from "./container_plan.ts";
import type { ContainerPlan } from "./state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// emptyContainerPlan
// ---------------------------------------------------------------------------

test("emptyContainerPlan: creates zero-value plan", () => {
  const plan = emptyContainerPlan("img:1.0", "/work");
  expect(plan.image).toEqual("img:1.0");
  expect(plan.workDir).toEqual("/work");
  expect(plan.mounts).toEqual([]);
  expect(plan.env.static).toEqual({});
  expect(plan.env.dynamicOps).toEqual([]);
  expect(plan.extraRunArgs).toEqual([]);
  expect(plan.command.agentCommand).toEqual([]);
  expect(plan.command.extraArgs).toEqual([]);
  expect(plan.labels).toEqual({});
});

// ---------------------------------------------------------------------------
// mergeContainerPlan — field-by-field semantics
// ---------------------------------------------------------------------------

test("mergeContainerPlan: mounts are appended", () => {
  const base = makeBasePlan({
    mounts: [{ source: "/a", target: "/a" }],
  });
  const patch: ContainerPatch = {
    mounts: [{ source: "/b", target: "/b", readOnly: true }],
  };
  const result = mergeContainerPlan(base, patch);
  expect(result.mounts).toEqual([
    { source: "/a", target: "/a" },
    { source: "/b", target: "/b", readOnly: true },
  ]);
});

test("mergeContainerPlan: env.static is key-merged (patch wins)", () => {
  const base = makeBasePlan({
    env: {
      static: { FOO: "base-foo", BAR: "base-bar" },
      dynamicOps: [],
    },
  });
  const patch: ContainerPatch = {
    env: { static: { FOO: "patch-foo", BAZ: "patch-baz" } },
  };
  const result = mergeContainerPlan(base, patch);
  expect(result.env.static).toEqual({
    FOO: "patch-foo",
    BAR: "base-bar",
    BAZ: "patch-baz",
  });
});

test("mergeContainerPlan: env.dynamicOps are appended", () => {
  const base = makeBasePlan({
    env: {
      static: {},
      dynamicOps: [
        { mode: "prefix", key: "PATH", value: "/a", separator: ":" },
      ],
    },
  });
  const patch: ContainerPatch = {
    env: {
      dynamicOps: [
        { mode: "suffix", key: "MANPATH", value: "/b", separator: ":" },
      ],
    },
  };
  const result = mergeContainerPlan(base, patch);
  expect(result.env.dynamicOps).toHaveLength(2);
  expect(result.env.dynamicOps[0].key).toEqual("PATH");
  expect(result.env.dynamicOps[1].key).toEqual("MANPATH");
});

test("mergeContainerPlan: extraRunArgs are appended", () => {
  const base = makeBasePlan({ extraRunArgs: ["--shm-size", "2g"] });
  const patch: ContainerPatch = { extraRunArgs: ["--privileged"] };
  const result = mergeContainerPlan(base, patch);
  expect(result.extraRunArgs).toEqual(["--shm-size", "2g", "--privileged"]);
});

test("mergeContainerPlan: labels are key-merged (patch wins)", () => {
  const base = makeBasePlan({
    labels: { "nas.managed": "true", "nas.kind": "agent" },
  });
  const patch: ContainerPatch = {
    labels: { "nas.kind": "dind", "nas.session": "sess_1" },
  };
  const result = mergeContainerPlan(base, patch);
  expect(result.labels).toEqual({
    "nas.managed": "true",
    "nas.kind": "dind",
    "nas.session": "sess_1",
  });
});

test("mergeContainerPlan: network is replaced", () => {
  const base = makeBasePlan({ network: { name: "base-net" } });
  const patch: ContainerPatch = { network: { name: "patch-net", alias: "alias1" } };
  const result = mergeContainerPlan(base, patch);
  expect(result.network).toEqual({ name: "patch-net", alias: "alias1" });
});

test("mergeContainerPlan: undefined network patch keeps base network", () => {
  const base = makeBasePlan({ network: { name: "base-net" } });
  const patch: ContainerPatch = {};
  const result = mergeContainerPlan(base, patch);
  expect(result.network).toEqual({ name: "base-net" });
});

test("mergeContainerPlan: command is replaced", () => {
  const base = makeBasePlan({
    command: { agentCommand: ["old-agent"], extraArgs: [] },
  });
  const patch: ContainerPatch = {
    command: { agentCommand: ["new-agent"], extraArgs: ["--fast"] },
  };
  const result = mergeContainerPlan(base, patch);
  expect(result.command).toEqual({
    agentCommand: ["new-agent"],
    extraArgs: ["--fast"],
  });
});

test("mergeContainerPlan: image and workDir are replaced", () => {
  const base = makeBasePlan({ image: "old:1", workDir: "/old" });
  const patch: ContainerPatch = { image: "new:2", workDir: "/new" };
  const result = mergeContainerPlan(base, patch);
  expect(result.image).toEqual("new:2");
  expect(result.workDir).toEqual("/new");
});

test("mergeContainerPlan: base is not mutated", () => {
  const base = makeBasePlan({ mounts: [{ source: "/a", target: "/a" }] });
  const baseMountsBefore = base.mounts.length;
  mergeContainerPlan(base, { mounts: [{ source: "/b", target: "/b" }] });
  expect(base.mounts.length).toEqual(baseMountsBefore);
});

// ---------------------------------------------------------------------------
// compileLaunchOpts — parity tests
// ---------------------------------------------------------------------------

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
  // Check encoded mount strings
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

  // extraRunArgs appear after network args
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

  // Verify args ordering: -w, -v mounts, --network, --network-alias, extraRunArgs
  const wIdx = opts.args.indexOf("-w");
  const firstVIdx = opts.args.indexOf("-v");
  const netIdx = opts.args.indexOf("--network");
  const shmIdx = opts.args.indexOf("--shm-size");
  expect(wIdx).toBeLessThan(firstVIdx);
  expect(firstVIdx).toBeLessThan(netIdx);
  expect(netIdx).toBeLessThan(shmIdx);
});
