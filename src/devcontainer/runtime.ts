import { Cause, Effect, Exit, Layer, Option } from "effect";
import { createCliInitialState } from "../cli/pipeline_state.ts";
import { loadConfig, resolveProfile } from "../config/load.ts";
import type { Config, Profile } from "../config/types.ts";
import { sharedDockerResources } from "../docker/shared_resources.ts";
import type { DevcontainerRegistration } from "../domain/devcontainer.ts";
import {
  resolveDevcontainerPaths,
  serveDevcontainerRuntime,
} from "../domain/devcontainer.ts";
import { checkNotifySend, resolveNotifyBackend } from "../lib/notify_utils.ts";
import { withPreparationCommands } from "../lib/preparation_commands.ts";
import { createPreparationPipelineBuilder } from "../pipeline/cli_builder.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import { createPipelineLiveLayer } from "../pipeline/live.ts";
import type { HostEnv } from "../pipeline/types.ts";
import { resolveBuildProbes } from "../stages/docker_build.ts";
import {
  ComposeSessionOps,
  ComposeSessionService,
  createComposeStage,
  makeComposeSessionOpsLive,
  serveComposeSession,
} from "../stages/launch.ts";
import {
  ensureDevcontainerAgentState,
  resolveMountProbes,
} from "../stages/mount.ts";
import { ensureUiDaemon } from "../ui/daemon.ts";

export interface DevcontainerRuntimeOptions {
  readonly registration: DevcontainerRegistration;
  readonly config: Config;
  readonly profile: Profile;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly startupDeadlineAt?: number;
  readonly host?: HostEnv;
}

export interface DevcontainerRuntimeResult {
  readonly exit: Exit.Exit<void, Error>;
  readonly containerName: string | null;
}

/** Application dispatch for the private detached `_serve` CLI entry. */
export async function runDevcontainerServeEntry(
  workspace: string,
  sessionId: string,
  deadlineAt: number,
): Promise<void> {
  const host = buildHostEnv();
  await serveDevcontainerRuntime({
    host,
    workspace,
    sessionId,
    deadlineAt,
    runRuntime: async (registration, signal, startupDeadlineAt) => {
      const config = await loadConfig({ startDir: registration.workspace });
      const resolved = resolveProfile(config, registration.profileName);
      const result = await runDevcontainerRuntime({
        registration,
        config,
        profile: resolved.profile,
        sessionId,
        signal,
        startupDeadlineAt,
        host,
      });
      return Exit.isSuccess(result.exit)
        ? { ok: true }
        : {
            ok: false,
            diagnostic: `devcontainer runtime failed: ${describeExitFailure(result.exit.cause).split("\n", 1)[0]}`,
          };
    },
  });
}

/**
 * Application boundary used by the detached `_serve` process.
 *
 * It resolves host probes, supplies UI/notification support, runs one scoped
 * preparation pipeline, and keeps that scope alive through ComposeSessionService.
 * Passing the caller's AbortSignal interrupts the Effect and waits for all
 * container and broker finalizers before this promise resolves.
 */
export async function runDevcontainerRuntime(
  options: DevcontainerRuntimeOptions,
): Promise<DevcontainerRuntimeResult> {
  const deadlineAt =
    options.startupDeadlineAt ??
    Date.now() + (options.startupTimeoutMs ?? 120_000);
  const host = options.host ?? buildHostEnv();
  const workspace = options.registration.workspace;
  const guard = createStartupGuard(deadlineAt, options.signal);
  const { probes, mountProbes, agentState, buildProbes } = await (async () => {
    try {
      const probes = await guard.wait(resolveProbes(host));
      const mountProbes = await guard.wait(
        resolveMountProbes(host, options.profile, workspace),
      );
      const agentState = await guard.wait(
        ensureDevcontainerAgentState(options.profile.agent, host.home),
      );
      const buildProbes = await guard.wait(
        resolveBuildProbes(sharedDockerResources(process.env).sandboxImage, {
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
          signal: guard.signal,
        }),
      );

      const networkNotify = resolveNotifyBackend(
        options.profile.network.pendingNotify,
      );
      const hostexecNotify = resolveNotifyBackend(
        options.profile.hostexec?.prompt.notify ?? "auto",
      );
      if (networkNotify === "desktop" || hostexecNotify === "desktop")
        checkNotifySend();
      if (options.config.ui.enable) {
        await guard.wait(
          ensureUiDaemon({
            port: options.config.ui.port,
            idleTimeout: options.config.ui.idleTimeout,
          }),
        );
      }
      return {
        probes,
        mountProbes,
        agentState,
        buildProbes,
      };
    } finally {
      guard.close();
    }
  })();
  process.env.NAS_SESSION_ID = options.sessionId;

  const input = {
    config: options.config,
    profile: options.profile,
    profileName: options.registration.profileName,
    sessionId: options.sessionId,
    host,
    probes,
  };
  const paths = resolveDevcontainerPaths(host, workspace);
  const preparationBuilder = createPreparationPipelineBuilder({
    input,
    buildProbes,
    mountProbes,
    devcontainerMounts: {
      ...agentState,
      vscodeDir: paths.vscodeDir,
    },
  });
  const composeStage = createComposeStage(input, {
    registration: options.registration,
  });

  const opsLayer = makeComposeSessionOpsLive(host);
  let containerName: string | null = null;
  const program = Effect.gen(function* () {
    const ops = yield* ComposeSessionOps;
    const composeLayer = Layer.succeed(
      ComposeSessionService,
      ComposeSessionService.of({
        serve: (next) => {
          containerName = next.containerName;
          return serveComposeSession(next, deadlineAt).pipe(
            Effect.provide(Layer.succeed(ComposeSessionOps, ops)),
          );
        },
      }),
    );
    const prepared = yield* preparationBuilder
      .run(
        createCliInitialState(
          workspace,
          sharedDockerResources(process.env).sandboxImage,
          {
            NAS_SESSION_ID: options.sessionId,
          },
        ),
      )
      .pipe(
        Effect.timeoutFail({
          duration: Math.max(0, deadlineAt - Date.now()),
          onTimeout: () => new Error("devcontainer startup deadline exceeded"),
        }),
      );
    yield* composeStage.run(prepared).pipe(Effect.provide(composeLayer));
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(createPipelineLiveLayer(), opsLayer)),
  );

  // Nothing forwards Ctrl-C to this detached process' children, so preparation
  // children such as docker build must be owned and cancelled explicitly when
  // the startup deadline interrupts the pipeline.
  const exit = await withPreparationCommands(
    options.signal ?? new AbortController().signal,
    () =>
      Effect.runPromiseExit(
        program,
        options.signal ? { signal: options.signal } : undefined,
      ),
  );
  const normalized: Exit.Exit<void, Error> = Exit.isSuccess(exit)
    ? Exit.succeed(undefined)
    : Exit.fail(new Error(describeExitFailure(exit.cause)));
  return { exit: normalized, containerName };
}

/**
 * A plain failure already carries its message. @internal exported for its test.
 *
 * `Cause.pretty` renders it as `Error: <message>`, so prettifying a cause that
 * was itself built from a prettified one prefixes `Error:` once per layer and
 * the diagnostic reaches the terminal as `Error: Error: ...`. Defects and
 * interruptions have no such message and still need the rendering.
 */
export function describeExitFailure(cause: Cause.Cause<unknown>): string {
  const failure = Cause.failureOption(cause);
  if (Option.isNone(failure)) return Cause.pretty(cause);
  const error = failure.value;
  return error instanceof Error ? error.message : String(error);
}

function createStartupGuard(deadlineAt: number, external?: AbortSignal) {
  const controller = new AbortController();
  const abortFromCaller = () =>
    controller.abort(new Error("devcontainer startup aborted"));
  if (external?.aborted) abortFromCaller();
  else external?.addEventListener("abort", abortFromCaller, { once: true });
  const remaining = deadlineAt - Date.now();
  const timer =
    remaining <= 0
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new Error("devcontainer startup deadline exceeded"),
            ),
          remaining,
        );
  if (remaining <= 0)
    controller.abort(new Error("devcontainer startup deadline exceeded"));

  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const aborted = () =>
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("devcontainer startup aborted"),
        );
      if (controller.signal.aborted) {
        aborted();
        return;
      }
      controller.signal.addEventListener("abort", aborted, { once: true });
      promise.then(
        (value) => {
          controller.signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        (error) => {
          controller.signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
  return {
    signal: controller.signal,
    wait,
    close: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", abortFromCaller);
    },
  };
}
