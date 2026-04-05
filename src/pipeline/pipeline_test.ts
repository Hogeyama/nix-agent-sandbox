import { assertEquals, assertRejects } from "@std/assert";
import { mergeOutputs, runPipeline } from "./pipeline.ts";
import type {
  AnyStage,
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

Deno.test("mergeOutputs: appends dockerArgs", () => {
  const prior = makePrior({ dockerArgs: ["--rm"] });
  const plan: StagePlan = {
    effects: [],
    dockerArgs: ["--network=host"],
    envVars: {},
    outputOverrides: {},
  };

  const result = mergeOutputs(prior, plan);
  assertEquals(result.dockerArgs, ["--rm", "--network=host"]);
});

Deno.test("mergeOutputs: merges envVars", () => {
  const prior = makePrior({ envVars: { A: "1" } });
  const plan: StagePlan = {
    effects: [],
    dockerArgs: [],
    envVars: { B: "2", A: "overridden" },
    outputOverrides: {},
  };

  const result = mergeOutputs(prior, plan);
  assertEquals(result.envVars, { A: "overridden", B: "2" });
});

Deno.test("mergeOutputs: applies outputOverrides", () => {
  const prior = makePrior({ nixEnabled: false, workDir: "/old" });
  const plan: StagePlan = {
    effects: [],
    dockerArgs: [],
    envVars: {},
    outputOverrides: { nixEnabled: true, workDir: "/new" },
  };

  const result = mergeOutputs(prior, plan);
  assertEquals(result.nixEnabled, true);
  assertEquals(result.workDir, "/new");
});

Deno.test("mergeOutputs: outputOverrides don't clobber dockerArgs/envVars merge", () => {
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
  assertEquals(result.dockerArgs, ["--rm", "--cap-add=SYS_PTRACE"]);
  assertEquals(result.envVars, { A: "1", B: "2" });
  assertEquals(result.imageName, "custom");
});

Deno.test("mergeOutputs: outputOverrides with dockerArgs/envVars are overridden by append/merge", () => {
  const prior = makePrior({
    dockerArgs: ["--rm"],
    envVars: { A: "1" },
  });
  // Even if outputOverrides contains dockerArgs/envVars, the explicit
  // append/merge from plan.dockerArgs and plan.envVars takes precedence.
  const plan: StagePlan = {
    effects: [],
    dockerArgs: ["--new"],
    envVars: { B: "2" },
    outputOverrides: {
      dockerArgs: ["--should-be-overridden"],
      envVars: { C: "should-be-overridden" },
    },
  };

  const result = mergeOutputs(prior, plan);
  // dockerArgs: spread of outputOverrides is overridden by the append logic
  assertEquals(result.dockerArgs, ["--rm", "--new"]);
  // envVars: spread of outputOverrides is overridden by the merge logic
  assertEquals(result.envVars, { A: "1", B: "2" });
});

// ---------------------------------------------------------------------------
// runPipeline — PlanStage
// ---------------------------------------------------------------------------

Deno.test("runPipeline: runs PlanStage and merges outputs", async () => {
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

  assertEquals(result.dockerArgs, ["--rm"]);
  assertEquals(result.envVars, { FOO: "bar" });
  assertEquals(result.nixEnabled, true);
});

Deno.test("runPipeline: skips PlanStage that returns null", async () => {
  const stage: PlanStage = {
    kind: "plan",
    name: "skip-stage",
    plan(): StagePlan | null {
      return null;
    },
  };

  const input = makeInput({ prior: makePrior({ workDir: "/original" }) });
  const result = await runPipeline([stage], input);

  assertEquals(result.workDir, "/original");
});

// ---------------------------------------------------------------------------
// runPipeline — ProceduralStage
// ---------------------------------------------------------------------------

Deno.test("runPipeline: runs ProceduralStage and merges overrides", async () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "proc-stage",
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: { workDir: "/changed", nixEnabled: true } };
    },
  };

  const result = await runPipeline([stage], makeInput());

  assertEquals(result.workDir, "/changed");
  assertEquals(result.nixEnabled, true);
});

Deno.test("runPipeline: ProceduralStage appends dockerArgs and merges envVars", async () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "proc-append",
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
  assertEquals([...result.dockerArgs], ["--existing", "--new-arg"]);
  // envVars should be merged, not replaced
  assertEquals(result.envVars, { OLD: "keep", NEW: "val" });
});

// ---------------------------------------------------------------------------
// runPipeline — mixed stages
// ---------------------------------------------------------------------------

Deno.test("runPipeline: runs mixed PlanStage and ProceduralStage in order", async () => {
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
    async execute(input: StageInput): Promise<ProceduralResult> {
      order.push("proc-second");
      // Verify it sees prior from plan stage
      assertEquals(input.prior.nixEnabled, true);
      return { outputOverrides: { workDir: "/proc-changed" } };
    },
  };

  const result = await runPipeline([planStage, procStage], makeInput());

  assertEquals(order, ["plan-first", "proc-second"]);
  assertEquals(result.dockerArgs, ["--rm"]);
  assertEquals(result.envVars, { FROM: "plan" });
  assertEquals(result.nixEnabled, true);
  assertEquals(result.workDir, "/proc-changed");
});

// ---------------------------------------------------------------------------
// runPipeline — teardown
// ---------------------------------------------------------------------------

Deno.test("runPipeline: calls teardown in reverse order on success", async () => {
  const order: string[] = [];

  const proc1: ProceduralStage = {
    kind: "procedural",
    name: "proc1",
    async execute(): Promise<ProceduralResult> {
      order.push("exec-proc1");
      return { outputOverrides: {} };
    },
    async teardown(): Promise<void> {
      order.push("teardown-proc1");
    },
  };

  const proc2: ProceduralStage = {
    kind: "procedural",
    name: "proc2",
    async execute(): Promise<ProceduralResult> {
      order.push("exec-proc2");
      return { outputOverrides: {} };
    },
    async teardown(): Promise<void> {
      order.push("teardown-proc2");
    },
  };

  await runPipeline([proc1, proc2], makeInput());

  assertEquals(order, [
    "exec-proc1",
    "exec-proc2",
    "teardown-proc2",
    "teardown-proc1",
  ]);
});

Deno.test("runPipeline: calls teardown on error (only completed stages)", async () => {
  const order: string[] = [];

  const proc1: ProceduralStage = {
    kind: "procedural",
    name: "proc1",
    async execute(): Promise<ProceduralResult> {
      order.push("exec-proc1");
      return { outputOverrides: {} };
    },
    async teardown(): Promise<void> {
      order.push("teardown-proc1");
    },
  };

  const proc2: ProceduralStage = {
    kind: "procedural",
    name: "proc2",
    async execute(): Promise<ProceduralResult> {
      order.push("exec-proc2");
      throw new Error("boom");
    },
    async teardown(): Promise<void> {
      order.push("teardown-proc2");
    },
  };

  await assertRejects(
    () => runPipeline([proc1, proc2], makeInput()),
    Error,
    "boom",
  );

  // proc2 failed during execute, so only proc1 gets teardown
  assertEquals(order, ["exec-proc1", "exec-proc2", "teardown-proc1"]);
});

Deno.test("runPipeline: ProceduralStage without teardown is fine", async () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "no-teardown",
    async execute(): Promise<ProceduralResult> {
      return { outputOverrides: {} };
    },
  };

  // Should not throw
  await runPipeline([stage], makeInput());
});

Deno.test("runPipeline: empty stages returns prior unchanged", async () => {
  const prior = makePrior({ workDir: "/original", nixEnabled: true });
  const result = await runPipeline([], makeInput({ prior }));

  assertEquals(result.workDir, "/original");
  assertEquals(result.nixEnabled, true);
});

// ---------------------------------------------------------------------------
// runPipeline — stages see accumulated prior
// ---------------------------------------------------------------------------

Deno.test("runPipeline: later stages see accumulated prior from earlier stages", async () => {
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
      assertEquals(input.prior.nixEnabled, true);
      assertEquals([...input.prior.dockerArgs], ["--from-stage1"]);
      assertEquals(input.prior.envVars, { S1: "v1" });
      return {
        effects: [],
        dockerArgs: ["--from-stage2"],
        envVars: { S2: "v2" },
        outputOverrides: {},
      };
    },
  };

  const result = await runPipeline([stage1, stage2], makeInput());

  assertEquals([...result.dockerArgs], ["--from-stage1", "--from-stage2"]);
  assertEquals(result.envVars, { S1: "v1", S2: "v2" });
  assertEquals(result.nixEnabled, true);
});
