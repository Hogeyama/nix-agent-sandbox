import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runPipelineEffect } from "./pipeline.ts";
import type {
  EffectStage,
  EffectStageResult,
  PriorStageOutputs,
  StageInput,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrior(overrides?: Partial<PriorStageOutputs>): PriorStageOutputs {
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

function makeInput(overrides?: Partial<StageInput>): StageInput {
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
// runPipelineEffect
// ---------------------------------------------------------------------------

test("runPipelineEffect: runs EffectStage and merges outputs", async () => {
  const stage: EffectStage<never> = {
    kind: "effect",
    name: "effect-stage",
    run(_input: StageInput) {
      return Effect.succeed({
        nixEnabled: true,
        workDir: "/changed",
      } as EffectStageResult);
    },
  };

  const result = await Effect.runPromise(
    runPipelineEffect([stage], makeInput()).pipe(Effect.scoped),
  );

  expect(result.nixEnabled).toEqual(true);
  expect(result.workDir).toEqual("/changed");
});

test("runPipelineEffect: later stages see accumulated prior", async () => {
  const stage1: EffectStage<never> = {
    kind: "effect",
    name: "stage1",
    run(_input: StageInput) {
      return Effect.succeed({ nixEnabled: true } as EffectStageResult);
    },
  };

  const stage2: EffectStage<never> = {
    kind: "effect",
    name: "stage2",
    run(input: StageInput) {
      expect(input.prior.nixEnabled).toEqual(true);
      return Effect.succeed({ workDir: "/from-stage2" } as EffectStageResult);
    },
  };

  const result = await Effect.runPromise(
    runPipelineEffect([stage1, stage2], makeInput()).pipe(Effect.scoped),
  );

  expect(result.nixEnabled).toEqual(true);
  expect(result.workDir).toEqual("/from-stage2");
});

test("runPipelineEffect: empty stages returns prior unchanged", async () => {
  const prior = makePrior({ workDir: "/original", nixEnabled: true });
  const result = await Effect.runPromise(
    runPipelineEffect([], makeInput({ prior })).pipe(Effect.scoped),
  );

  expect(result.workDir).toEqual("/original");
  expect(result.nixEnabled).toEqual(true);
});
