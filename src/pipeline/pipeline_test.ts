import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mergeOutputs, runPipeline } from "./pipeline.ts";
import type {
  PlanStage,
  PriorStageOutputs,
  ProceduralResult,
  ProceduralStage,
  StageInput,
  StagePlan,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrior(
  overrides?: Partial<PriorStageOutputs>,
): PriorStageOutputs {
  return {
    dockerArgs: [],
    envVars: {},
    workDir: "/workspace",
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: ["claude"],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...overrides,
  };
}

function makeInput(
  overrides?: Partial<StageInput>,
): StageInput {
  return {
    config: { profiles: {} } as StageInput["config"],
    profile: { agent: "claude" } as StageInput["profile"],
    profileName: "test",
    sessionId: "sess_test",
    host: {
      home: "/home/user",
      user: "user",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map(),
    },
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/nas-audit",
    },
    prior: makePrior(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mergeOutputs
// ---------------------------------------------------------------------------

test("mergeOutputs: appends dockerArgs", () => {
  const prior = makePrior({ dockerArgs: ["--rm"] });
  const plan: StagePlan = {
    effects: [],
    dockerArgs: ["--network=host"],
    envVars: {},
    outputOverrides: {},
  };

  const result = mergeOutputs(prior, plan);
  expect(result.dockerArgs).toEqual(["--rm", "--network=host"]);
});

test("mergeOutputs: merges envVars", () => {
  const prior = makePrior({ envVars: { A: "1" } });
  const plan: StagePlan = {
    effects: [],
    dockerArgs: [],
    envVars: { B: "2", A: "overridden" },
    outputOverrides: {},
  };

  const result = mergeOutputs(prior, plan);
  expect(result.envVars).toEqual({ A: "overridden", B: "2" });
});

test("mergeOutputs: applies outputOverrides", () => {
  const prior = makePrior({ nixEnabled: false, workDir: "/old" });
  const plan: StagePlan = {
    effects: [],
    dockerArgs: [],
    envVars: {},
    outputOverrides: { nixEnabled: true, workDir: "/new" },
  };

  const result = mergeOutputs(prior, plan);
  expect(result.nixEnabled).toEqual(true);
  expect(result.workDir).toEqual("/new");
});

test("mergeOutputs: outputOverrides don't clobber dockerArgs/envVars merge", () => {
  const prior = makePrior({
    dockerArgs: ["--rm"],
    envVars: { A: "1" },
  });
  const plan: StagePlan = {
    effects: [],
    dockerArgs: ["--cap-add=SYS_PTRACE"],
    envVars: { B: "2" },
    outputOverrides: { imageName: "custom" },
  };

  const result = mergeOutputs(prior, plan);
  // dockerArgs should be appended, not replaced by outputOverrides
  expect(result.dockerArgs).toEqual(["--rm", "--cap-add=SYS_PTRACE"]);
  expect(result.envVars).toEqual({ A: "1", B: "2" });
  expect(result.imageName).toEqual("custom");
});

test("mergeOutputs: outputOverrides.dockerArgs replaces prior as base, plan.dockerArgs appended", () => {
  const prior = makePrior({
    dockerArgs: ["--rm"],
    envVars: { A: "1" },
  });
  // outputOverrides.dockerArgs replaces prior.dockerArgs as the base,
  // then plan.dockerArgs is appended on top.
  const plan: StagePlan = {
    effects: [],
    dockerArgs: ["--new"],
    envVars: { B: "2" },
    outputOverrides: {
      dockerArgs: ["--replaced-base"],
      envVars: { C: "should-be-overridden" },
    },
  };

  const result = mergeOutputs(prior, plan);
  // dockerArgs: outputOverrides.dockerArgs is the new base, plan.dockerArgs appended
  expect(result.dockerArgs).toEqual(["--replaced-base", "--new"]);
  // envVars: spread of outputOverrides is overridden by the merge logic
  expect(result.envVars).toEqual({ A: "1", B: "2" });
});

// ---------------------------------------------------------------------------
// runPipeline — PlanStage
// ---------------------------------------------------------------------------

test("runPipeline: runs PlanStage and merges outputs", async () => {
  const stage: PlanStage = {
    kind: "plan",
    name: "plan-stage",
    plan(_input: StageInput): StagePlan | null {
      return {
        effects: [],
        dockerArgs: ["--rm"],
        envVars: { FOO: "bar" },
        outputOverrides: { nixEnabled: true },
      };
    },
  };

  const result = await runPipeline([stage], makeInput());

  expect(result.dockerArgs).toEqual(["--rm"]);
  expect(result.envVars).toEqual({ FOO: "bar" });
  expect(result.nixEnabled).toEqual(true);
});

test("runPipeline: skips PlanStage that returns null", async () => {
  const stage: PlanStage = {
    kind: "plan",
    name: "skip-stage",
    plan(): StagePlan | null {
      return null;
    },
  };

  const input = makeInput({ prior: makePrior({ workDir: "/original" }) });
  const result = await runPipeline([stage], input);

  expect(result.workDir).toEqual("/original");
});

// ---------------------------------------------------------------------------
// runPipeline — ProceduralStage
// ---------------------------------------------------------------------------

test("runPipeline: runs ProceduralStage and merges overrides", async () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "proc-stage",
    // deno-lint-ignore require-await
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: { workDir: "/changed", nixEnabled: true } };
    },
  };

  const result = await runPipeline([stage], makeInput());

  expect(result.workDir).toEqual("/changed");
  expect(result.nixEnabled).toEqual(true);
});

test("runPipeline: ProceduralStage appends dockerArgs and merges envVars", async () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "proc-append",
    // deno-lint-ignore require-await
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return {
        outputOverrides: {
          dockerArgs: ["--new-arg"],
          envVars: { NEW: "val" },
        },
      };
    },
  };

  const input = makeInput({
    prior: makePrior({
      dockerArgs: ["--existing"],
      envVars: { OLD: "keep" },
    }),
  });
  const result = await runPipeline([stage], input);

  // dockerArgs should be appended, not replaced
  expect([...result.dockerArgs]).toEqual(["--existing", "--new-arg"]);
  // envVars should be merged, not replaced
  expect(result.envVars).toEqual({ OLD: "keep", NEW: "val" });
});

// ---------------------------------------------------------------------------
// runPipeline — mixed stages
// ---------------------------------------------------------------------------

test("runPipeline: runs mixed PlanStage and ProceduralStage in order", async () => {
  const order: string[] = [];

  const planStage: PlanStage = {
    kind: "plan",
    name: "plan-first",
    plan(_input: StageInput): StagePlan | null {
      order.push("plan-first");
      return {
        effects: [],
        dockerArgs: ["--rm"],
        envVars: { FROM: "plan" },
        outputOverrides: { nixEnabled: true },
      };
    },
  };

  const procStage: ProceduralStage = {
    kind: "procedural",
    name: "proc-second",
    // deno-lint-ignore require-await
    async execute(input: StageInput): Promise<ProceduralResult> {
      order.push("proc-second");
      // Verify it sees prior from plan stage
      expect(input.prior.nixEnabled).toEqual(true);
      return { outputOverrides: { workDir: "/proc-changed" } };
    },
  };

  const result = await runPipeline([planStage, procStage], makeInput());

  expect(order).toEqual(["plan-first", "proc-second"]);
  expect(result.dockerArgs).toEqual(["--rm"]);
  expect(result.envVars).toEqual({ FROM: "plan" });
  expect(result.nixEnabled).toEqual(true);
  expect(result.workDir).toEqual("/proc-changed");
});

// ---------------------------------------------------------------------------
// runPipeline — teardown
// ---------------------------------------------------------------------------

test("runPipeline: calls teardown in reverse order on success", async () => {
  const order: string[] = [];

  const proc1: ProceduralStage = {
    kind: "procedural",
    name: "proc1",
    // deno-lint-ignore require-await
    async execute(): Promise<ProceduralResult> {
      order.push("exec-proc1");
      return { outputOverrides: {} };
    },
    // deno-lint-ignore require-await
    async teardown(): Promise<void> {
      order.push("teardown-proc1");
    },
  };

  const proc2: ProceduralStage = {
    kind: "procedural",
    name: "proc2",
    // deno-lint-ignore require-await
    async execute(): Promise<ProceduralResult> {
      order.push("exec-proc2");
      return { outputOverrides: {} };
    },
    // deno-lint-ignore require-await
    async teardown(): Promise<void> {
      order.push("teardown-proc2");
    },
  };

  await runPipeline([proc1, proc2], makeInput());

  expect(order).toEqual([
    "exec-proc1",
    "exec-proc2",
    "teardown-proc2",
    "teardown-proc1",
  ]);
});

test("runPipeline: calls teardown on error (only completed stages)", async () => {
  const order: string[] = [];

  const proc1: ProceduralStage = {
    kind: "procedural",
    name: "proc1",
    // deno-lint-ignore require-await
    async execute(): Promise<ProceduralResult> {
      order.push("exec-proc1");
      return { outputOverrides: {} };
    },
    // deno-lint-ignore require-await
    async teardown(): Promise<void> {
      order.push("teardown-proc1");
    },
  };

  const proc2: ProceduralStage = {
    kind: "procedural",
    name: "proc2",
    // deno-lint-ignore require-await
    async execute(): Promise<ProceduralResult> {
      order.push("exec-proc2");
      throw new Error("boom");
    },
    // deno-lint-ignore require-await
    async teardown(): Promise<void> {
      order.push("teardown-proc2");
    },
  };

  await expect(runPipeline([proc1, proc2], makeInput())).rejects.toThrow(
    "boom",
  );

  // proc2 failed during execute, so only proc1 gets teardown
  expect(order).toEqual(["exec-proc1", "exec-proc2", "teardown-proc1"]);
});

test("runPipeline: ProceduralStage without teardown is fine", async () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "no-teardown",
    // deno-lint-ignore require-await
    async execute(): Promise<ProceduralResult> {
      return { outputOverrides: {} };
    },
  };

  // Should not throw
  await runPipeline([stage], makeInput());
});

test("runPipeline: empty stages returns prior unchanged", async () => {
  const prior = makePrior({ workDir: "/original", nixEnabled: true });
  const result = await runPipeline([], makeInput({ prior }));

  expect(result.workDir).toEqual("/original");
  expect(result.nixEnabled).toEqual(true);
});

// ---------------------------------------------------------------------------
// runPipeline — stages see accumulated prior
// ---------------------------------------------------------------------------

test("runPipeline: later stages see accumulated prior from earlier stages", async () => {
  const stage1: PlanStage = {
    kind: "plan",
    name: "stage1",
    plan(): StagePlan | null {
      return {
        effects: [],
        dockerArgs: ["--from-stage1"],
        envVars: { S1: "v1" },
        outputOverrides: { nixEnabled: true },
      };
    },
  };

  const stage2: PlanStage = {
    kind: "plan",
    name: "stage2",
    plan(input: StageInput): StagePlan | null {
      // stage2 should see stage1's outputs
      expect(input.prior.nixEnabled).toEqual(true);
      expect([...input.prior.dockerArgs]).toEqual(["--from-stage1"]);
      expect(input.prior.envVars).toEqual({ S1: "v1" });
      return {
        effects: [],
        dockerArgs: ["--from-stage2"],
        envVars: { S2: "v2" },
        outputOverrides: {},
      };
    },
  };

  const result = await runPipeline([stage1, stage2], makeInput());

  expect([...result.dockerArgs]).toEqual(["--from-stage1", "--from-stage2"]);
  expect(result.envVars).toEqual({ S1: "v1", S2: "v2" });
  expect(result.nixEnabled).toEqual(true);
});
