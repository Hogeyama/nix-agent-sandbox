import { expect, test } from "bun:test";

/**
 * ObservabilityStage unit tests.
 *
 * The stage materializes the `observability` slice of PipelineState and
 * always produces the disabled fast-path slice `{ enabled: false }`. The
 * enabled branch is not implemented here.
 */

import { Effect } from "effect";
import { createObservabilityStage, planObservability } from "./stage.ts";

test("planObservability: returns disabled slice", () => {
  const slice = planObservability();
  expect(slice).toEqual({ enabled: false });
});

test("planObservability: returns disabled slice regardless of config.observability.enable", () => {
  // The planner takes no inputs, so the slice shape is fixed at the type
  // level: it cannot vary with config. This call pins that property at
  // runtime as well.
  const slice = planObservability();
  expect(slice).toEqual({ enabled: false });
});

test("ObservabilityStage: declares no slice dependencies", () => {
  const stage = createObservabilityStage();
  expect(stage.name).toEqual("ObservabilityStage");
  expect(stage.needs).toEqual([]);
});

test("ObservabilityStage: run produces { observability: { enabled: false } }", async () => {
  const stage = createObservabilityStage();
  const result = await Effect.runPromise(Effect.scoped(stage.run({})));
  expect(result).toEqual({ observability: { enabled: false } });
});
