import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runPipelineEffect } from "./pipeline.ts";
import type {
  EffectStage,
  EffectStageResult,
  PriorStageOutputs,
  StageInput,
} from "./types.ts";
import { createPipelineBuilder } from "./stage_builder.ts";
import type { Stage } from "./stage_builder.ts";
import type { NixState, PipelineState, WorkspaceState } from "./state.ts";

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

// ---------------------------------------------------------------------------
// PipelineBuilder (stage_builder.ts)
// ---------------------------------------------------------------------------

test("createPipelineBuilder: returns empty builder with no stages", () => {
  const builder = createPipelineBuilder();
  expect(builder.getStages()).toHaveLength(0);
});

test("PipelineBuilder.add: appends stage to internal list", () => {
  // A stage that requires no slices and produces `workspace`.
  const wsStage: Stage<never, Pick<PipelineState, "workspace">> = {
    name: "workspace-stage",
    needs: [],
    run: (_input) => {
      throw new Error("not called in this test");
    },
  };

  const builder = createPipelineBuilder().add(wsStage);
  expect(builder.getStages()).toHaveLength(1);
  expect(builder.getStages()[0].name).toEqual("workspace-stage");
});

test("PipelineBuilder.add: chaining multiple stages accumulates them in order", () => {
  const wsStage: Stage<never, Pick<PipelineState, "workspace">> = {
    name: "workspace-stage",
    needs: [],
    run: (_input) => {
      throw new Error("not called");
    },
  };

  // Requires `workspace` (provided by wsStage above).
  const nixStage: Stage<"workspace", Pick<PipelineState, "nix">> = {
    name: "nix-stage",
    needs: ["workspace"],
    run: (_input: Pick<PipelineState, "workspace">) => {
      throw new Error("not called");
    },
  };

  const builder = createPipelineBuilder().add(wsStage).add(nixStage);
  const stages = builder.getStages();

  expect(stages).toHaveLength(2);
  expect(stages[0].name).toEqual("workspace-stage");
  expect(stages[1].name).toEqual("nix-stage");
});

test("PipelineBuilder.run: throws before C11 wiring", () => {
  const builder = createPipelineBuilder<Pick<PipelineState, "workspace">>();
  expect(() => {
    // Cast to any to bypass the `Initial` constraint in tests.
    // biome-ignore lint/suspicious/noExplicitAny: test-only bypass
    (builder as any).run({
      workspace: { workDir: "/workspace", imageName: "img" },
    });
  }).toThrow("not yet implemented");
});

// Suppress unused imports satisfied by type-only usage above.
void (null as unknown as WorkspaceState);
void (null as unknown as NixState);

// ---------------------------------------------------------------------------
// Negative type-level test: optional slices must not satisfy MissingMarker
// ---------------------------------------------------------------------------

test("PipelineBuilder [type-level]: optional workspace in Current does not satisfy a stage that needs workspace", () => {
  // A stage that explicitly requires the workspace slice.
  const stageNeedingWorkspace: Stage<"workspace", Pick<PipelineState, "nix">> =
    {
      name: "nix-from-workspace",
      needs: ["workspace"],
      run: (_input) => {
        throw new Error("not called");
      },
    };

  // createPipelineBuilder<{ workspace?: WorkspaceState }>() produces a builder
  // whose Current has workspace as an *optional* key.  MissingMarker must
  // treat optional keys as unavailable and reject the add() call.
  //
  // The @ts-expect-error directive is the assertion: if tsc does NOT emit an
  // error here, `bun run check` fails with "Unused @ts-expect-error directive",
  // proving the type-level guard is in effect.
  // @ts-expect-error — workspace is optional in Current, so MissingMarker → never
  createPipelineBuilder<{ workspace?: WorkspaceState }>().add(stageNeedingWorkspace);
});
