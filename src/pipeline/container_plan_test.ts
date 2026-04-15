import { expect, test } from "bun:test";
import {
  type ContainerPatch,
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
