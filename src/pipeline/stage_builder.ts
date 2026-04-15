/**
 * Typed PipelineBuilder scaffold.
 *
 * Provides the new Stage interface and PipelineBuilder class for the
 * slice-based pipeline architecture defined in plan.md §2 & §4.
 *
 * Type guarantees:
 *   - `add()` is a compile error when a stage's `Needs` slices are not yet
 *     available in the builder's `Current` state.
 *   - Service requirements (`R`) and error channels (`E`) are accumulated
 *     across all stages and re-surfaced on `run()`.
 */

import type { Effect, Scope } from "effect";
import { runPipelineState } from "./pipeline.ts";
import type { PipelineState, SliceKey } from "./state.ts";
import type { StageServices } from "./types.ts";

// ---------------------------------------------------------------------------
// Stage interface
// ---------------------------------------------------------------------------

/**
 * A stage that reads a typed subset of PipelineState and produces new slices.
 *
 * `run` is a thunk (not a bare Effect value) so that prior state is passed
 * directly as a typed `Pick<PipelineState, Needs>` argument.  A bare Effect
 * value would force injecting prior state via a service, which would silently
 * lose the `Pick` static guarantee.
 *
 * @typeParam Needs  Slice keys this stage reads.
 * @typeParam Adds   Partial PipelineState this stage produces.
 * @typeParam R      Effect service requirements.
 * @typeParam E      Effect error channel.
 */
export interface Stage<
  Needs extends SliceKey,
  Adds extends Partial<PipelineState>,
  R extends StageServices = never,
  E = never,
> {
  readonly name: string;
  /** Slice keys the stage reads — mirrors the Needs type parameter at runtime. */
  readonly needs: readonly Needs[];
  readonly run: (
    input: Pick<PipelineState, Needs>,
  ) => Effect.Effect<Adds, E, R | Scope.Scope>;
}

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

/**
 * Produces `never` when `Needs` contains a slice key not yet present in
 * `Current`.  Intersecting a Stage with `MissingMarker<Current, Needs>` turns
 * missing-slice calls into type errors without requiring conditional types on
 * the return side.
 *
 * - All Needs keys available → `unknown` → intersection is transparent.
 * - Any Needs key missing   → `never`   → parameter type = `never` → error.
 *
 * Availability is determined by `RequiredKeys<Current>`, not raw `keyof`.
 * Optional properties in Current (e.g. `workspace?: ...`) do NOT count as
 * available — a stage cannot declare a slice available unless it is guaranteed
 * to be present.
 */

/**
 * Extract only the required (non-optional) keys of `T`.
 * `{} extends Pick<T, K>` is true when K is optional, false when required.
 */
type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

type MissingMarker<Current, Needs> = [
  Exclude<Needs & SliceKey, RequiredKeys<Current>>,
] extends [never]
  ? unknown
  : never;

/**
 * Merge the keys produced by `Adds` into `Current`, promoting optional slice
 * fields to required.
 */
type MergeState<Current, Adds> = Omit<Current, keyof Required<Adds>> &
  Required<Adds>;

// ---------------------------------------------------------------------------
// Erased stage for internal runtime storage
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: type-erased for homogeneous storage
type ErasedStage = Stage<SliceKey, Partial<PipelineState>, any, any>;

// ---------------------------------------------------------------------------
// PipelineBuilder
// ---------------------------------------------------------------------------

/**
 * Accumulates stages and tracks the set of available slices at compile time.
 *
 * `add()` accepts a stage only when all its `Needs` slices are already
 * provided by `Current`.  Attempting to add a stage whose requirements are
 * not yet met is a compile error.
 *
 * @typeParam Initial  The slice subset present before the pipeline starts.
 * @typeParam Current  Slices available at the current builder position.
 * @typeParam RAcc     Union of all accumulated Effect service requirements.
 * @typeParam EAcc     Union of all accumulated Effect error types.
 */
export class PipelineBuilder<
  Initial extends Partial<PipelineState>,
  Current extends Partial<PipelineState>,
  RAcc extends StageServices = never,
  EAcc = never,
> {
  private readonly _stages: readonly ErasedStage[];

  constructor(stages: readonly ErasedStage[] = []) {
    this._stages = stages;
  }

  /**
   * Append a stage.  Compile error if a required slice is not yet in Current.
   */
  add<
    Needs extends SliceKey,
    Adds extends Partial<PipelineState>,
    R extends StageServices = never,
    E = never,
  >(
    stage: Stage<Needs, Adds, R, E> & MissingMarker<Current, Needs>,
  ): PipelineBuilder<Initial, MergeState<Current, Adds>, RAcc | R, EAcc | E> {
    return new PipelineBuilder<
      Initial,
      MergeState<Current, Adds>,
      RAcc | R,
      EAcc | E
    >([...this._stages, stage as ErasedStage]);
  }

  /**
   * Execute the pipeline starting from `initial`.
   * Returns the accumulated PipelineState after all stages have run.
   */
  run(
    initial: Initial,
  ): Effect.Effect<Current, EAcc, RAcc | Scope.Scope> {
    return runPipelineState(this._stages, initial) as unknown as Effect.Effect<
      Current,
      EAcc,
      RAcc | Scope.Scope
    >;
  }

  /** Retrieve the accumulated stages (for introspection and testing). */
  getStages(): readonly ErasedStage[] {
    return this._stages;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an empty PipelineBuilder.
 *
 * Declare `Initial` when some slices are pre-populated before the first stage
 * (e.g. `workspace` injected from CLI context):
 *
 * ```ts
 * const builder = createPipelineBuilder<Pick<PipelineState, "workspace">>();
 * ```
 */
export function createPipelineBuilder<
  Initial extends Partial<PipelineState> = Record<never, never>,
>(): PipelineBuilder<Initial, Initial> {
  return new PipelineBuilder<Initial, Initial>([]);
}
