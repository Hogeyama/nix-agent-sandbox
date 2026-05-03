/**
 * ObservabilityStage — materializes the `observability` slice of PipelineState
 * and, when enabled, acquires the per-session OTLP/HTTP receiver and merges
 * the agent-specific container wiring patch.
 *
 * Inputs:
 *   - `config.observability.enable` gates the entire stage. Disabled → the
 *     stage is a no-op fast-path: `{ enabled: false }` slice and an empty
 *     container patch.
 *   - `profile.agent` selects the pure wiring contract provided by
 *     `src/agents/observability.ts`.
 *
 * Resource lifetime:
 *   - The receiver handle is bound to the stage's Effect scope via
 *     `Effect.acquireRelease`. The pipeline runner runs stages in order under
 *     a single scope, so the listener stays up for the rest of the session
 *     and is torn down on scope close (LIFO, after stages registered later
 *     such as ProxyStage / LaunchStage have released). Release callback
 *     swallows close failures with a stderr warn so a flaky teardown of the
 *     receiver does not block release of other resources in the same scope.
 *
 * Best-effort policy on history db open:
 *   - The stage opens the writer-mode history db handle to feed the receiver.
 *     If that open fails (corrupted file, schema version mismatch, permission
 *     error, ...), the stage degrades to the disabled slice and emits a
 *     stderr warning. This matches the cli_lifecycle invocation-row policy:
 *     telemetry must never block the agent run.
 *
 * Pipeline placement: between HostExecStage and DindStage. This is after the
 * agent-specific env (MountStage) so the OTLP envs win on key-collisions
 * (mergeContainerPlan is patch-wins on env.static), and before ProxyStage so
 * that ProxyStage can read the receiverPort from the slice and merge it into
 * its forwardPorts list.
 */

import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import {
  agentSupportsObservability,
  buildAgentObservabilityContainerPatch,
  canApplyAgentObservabilityConfig,
} from "../../agents/observability.ts";
import type { Config, Profile } from "../../config/types.ts";
import {
  HistoryDbVersionMismatchError,
  openHistoryDb,
  resolveHistoryDbPath,
} from "../../history/store.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type {
  ObservabilityState,
  PipelineState,
} from "../../pipeline/state.ts";
import type { StageResult } from "../../pipeline/types.ts";
import { OtlpReceiverService } from "./receiver_service.ts";

// ---------------------------------------------------------------------------
// Stage deps
// ---------------------------------------------------------------------------

export interface ObservabilityStageDeps {
  readonly config: Pick<Config, "observability">;
  readonly profile: Pick<Profile, "agent">;
  readonly profileName: string;
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

/**
 * Pure decision: should this session run with the receiver wired up?
 *
 * The stage maintains the invariant "enabled ⇔ receiver wiring applied ⇔
 * port acquired".
 * Two predicates must hold:
 *   - the operator opted in via `config.observability.enable`;
 *   - the selected agent has a supported receiver wiring
 *     (checked via {@link agentSupportsObservability}).
 *
 * Returning `false` for an unsupported agent keeps the slice consistent: no
 * listener burned, no receiverPort exposed for a stream that will never
 * arrive, and no container patch that would mislead operators.
 */
export function shouldEnableObservability(deps: {
  readonly config: Pick<Config, "observability">;
  readonly profile: Pick<Profile, "agent">;
}): boolean {
  if (!deps.config.observability.enable) return false;
  if (!agentSupportsObservability(deps.profile.agent)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createObservabilityStage(
  deps: ObservabilityStageDeps,
): Stage<
  "container",
  Pick<StageResult, "observability" | "container">,
  OtlpReceiverService,
  Error
> {
  return {
    name: "ObservabilityStage",
    needs: ["container"],
    run: (input) => runObservability(deps, input),
  };
}

function runObservability(
  deps: ObservabilityStageDeps,
  input: Pick<PipelineState, "container">,
): Effect.Effect<
  Pick<StageResult, "observability" | "container">,
  Error,
  OtlpReceiverService | import("effect").Scope.Scope
> {
  return Effect.gen(function* () {
    if (!shouldEnableObservability(deps)) {
      const slice: ObservabilityState = { enabled: false };
      return { observability: slice };
    }
    if (
      !canApplyAgentObservabilityConfig(
        deps.profile.agent,
        input.container.command.agentCommand,
      )
    ) {
      const slice: ObservabilityState = { enabled: false };
      return { observability: slice };
    }

    // Open the writer-mode history db. openHistoryDb caches on
    // `${mode}::${path}`, so when cli_lifecycle has already opened the same
    // (path, "readwrite") handle for invocation row writes, we share that
    // handle here rather than racing a second writer.
    //
    // Best-effort: if the db cannot be opened (corruption, schema mismatch,
    // permission error), degrade to the disabled slice rather than failing
    // the pipeline. Telemetry must never block the agent run; the
    // cli_lifecycle invocation-row writer applies the same policy on the
    // same file, so observability and history degrade in lockstep.
    const dbOrNull = yield* Effect.sync((): Database | null => {
      try {
        return openHistoryDb({
          path: resolveHistoryDbPath(),
          mode: "readwrite",
        });
      } catch (e) {
        if (e instanceof HistoryDbVersionMismatchError) {
          console.warn(
            `nas: history db schema version mismatch (expected 1, got ${e.actual}). ` +
              `Run 'rm ${resolveHistoryDbPath()}' and re-run nas to recreate. ` +
              `Continuing with observability disabled.`,
          );
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            `nas: history db open failed for observability: ${msg}. ` +
              `Continuing with observability disabled.`,
          );
        }
        return null;
      }
    });

    if (dbOrNull === null) {
      const slice: ObservabilityState = { enabled: false };
      return { observability: slice };
    }
    const db: Database = dbOrNull;

    const receiver = yield* OtlpReceiverService;
    const handle = yield* Effect.acquireRelease(
      receiver.start({
        db,
        fallbackMetadata: {
          sessionId: deps.sessionId,
          profileName: deps.profileName,
          agent: deps.profile.agent,
        },
      }),
      (h) =>
        // Use tryPromise so a rejection from h.close() surfaces as a typed
        // failure rather than an unhandled defect. The failure is then
        // demoted to a stderr warning and ignored, so a flaky teardown does
        // not block release of other resources registered in the same scope.
        Effect.tryPromise({
          try: () => h.close(),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(
          Effect.tapError((err) =>
            Effect.sync(() =>
              console.warn(
                `nas: observability receiver close failed: ${err.message}`,
              ),
            ),
          ),
          Effect.ignore,
        ),
    );

    const patch = buildAgentObservabilityContainerPatch({
      agent: deps.profile.agent,
      sessionId: deps.sessionId,
      profileName: deps.profileName,
      port: handle.port,
      agentCommand: input.container.command.agentCommand,
      extraArgs: input.container.command.extraArgs,
    });

    const slice: ObservabilityState = {
      enabled: true,
      receiverPort: handle.port,
    };

    // mergeContainerPlan with patch.env.static is patch-wins on key collisions,
    // so OTLP keys produced by the agent contract replace upstream values.
    const container = mergeContainerPlan(input.container, patch);
    return { observability: slice, container };
  });
}
