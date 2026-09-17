import { Context, Effect, Exit, Layer, Schedule } from "effect";
import { runDockerCommand } from "../../docker/client.ts";
import type {
  DevcontainerRegistration,
  DevcontainerSessionRecord,
} from "../../domain/devcontainer.ts";
import {
  readDevcontainerSession,
  withDevcontainerOperationLock,
  writeDevcontainerSession,
} from "../../domain/devcontainer.ts";
import { atomicWriteFile } from "../../lib/fs_utils.ts";
import { runPreparationTeardown } from "../../lib/preparation_commands.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import { compileCompose, serializeCompose } from "./compose.ts";

const READY_MARKER = "/run/nas-devcontainer/ready";

export interface ComposeSessionRequest {
  readonly registration: DevcontainerRegistration;
  readonly sessionId: string;
  readonly containerName: string;
  readonly container: ContainerPlan;
}

export interface ComposeSessionServiceApi {
  /**
   * Starts the container and then stays suspended until interrupted.
   *
   * The suspension is the point: this effect runs inside the detached
   * `devcontainer _serve` process and its scope owns the network broker,
   * hostexec broker, mask filesystem, and port-bind relays. Returning would
   * finalize all of them while the container is still running. Docker, not
   * nas, watches the container itself.
   */
  readonly serve: (
    request: ComposeSessionRequest,
  ) => Effect.Effect<void, Error, import("effect").Scope.Scope>;
}

export class ComposeSessionService extends Context.Tag(
  "nas/ComposeSessionService",
)<ComposeSessionService, ComposeSessionServiceApi>() {}

type Phase = DevcontainerSessionRecord["phase"];

/** @internal exported for focused lifecycle tests. */
export class ComposeSessionOps extends Context.Tag("nas/ComposeSessionOps")<
  ComposeSessionOps,
  {
    readonly publishCompose: (
      path: string,
      bytes: string,
    ) => Effect.Effect<void, Error>;
    readonly publishPhase: (
      request: ComposeSessionRequest,
      phase: Phase,
      containerId: string | null,
      diagnostic: string | null,
    ) => Effect.Effect<void, Error>;
    readonly composeUp: (path: string) => Effect.Effect<void, Error>;
    readonly composeContainerId: (path: string) => Effect.Effect<string, Error>;
    readonly probeReadyMarker: (id: string) => Effect.Effect<void, Error>;
    readonly composeDown: (path: string) => Effect.Effect<void, Error>;
  }
>() {}

export interface ComposeSessionServiceFakeConfig {
  readonly serve?: ComposeSessionServiceApi["serve"];
}

export function makeComposeSessionServiceFake(
  overrides: ComposeSessionServiceFakeConfig = {},
): Layer.Layer<ComposeSessionService> {
  return Layer.succeed(
    ComposeSessionService,
    ComposeSessionService.of({
      serve: overrides.serve ?? (() => Effect.never),
    }),
  );
}

export function composeProjectName(request: ComposeSessionRequest): string {
  return `nas-devcontainer-${request.registration.workspaceId.slice(0, 24)}`;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** D2 lifecycle: every external operation is supplied through ComposeSessionOps. */
export function serveComposeSession(
  request: ComposeSessionRequest,
  deadlineAt: number,
): Effect.Effect<
  void,
  Error,
  ComposeSessionOps | import("effect").Scope.Scope
> {
  let ownedId: string | null = null;
  let ready = false;
  const startup = Effect.gen(function* () {
    const ops = yield* ComposeSessionOps;
    const document = compileCompose(
      request.container,
      request.containerName,
      composeProjectName(request),
    );
    yield* ops.publishCompose(
      request.registration.composePath,
      serializeCompose(document),
    );
    yield* ops.publishPhase(request, "starting", null, null);
    yield* ops.composeUp(request.registration.composePath);
    ownedId = yield* ops.composeContainerId(request.registration.composePath);
    if (!ownedId)
      return yield* Effect.fail(
        new Error("Compose did not return a container ID"),
      );
    yield* ops
      .probeReadyMarker(ownedId)
      .pipe(Effect.retry(Schedule.spaced("100 millis")));
    yield* ops.publishPhase(request, "ready", ownedId, null);
    ready = true;
  }).pipe(
    Effect.timeoutFail({
      duration: Math.max(0, deadlineAt - Date.now()),
      onTimeout: () => new Error("devcontainer startup deadline exceeded"),
    }),
  );

  const cleanup = (exit: Exit.Exit<void, Error>) =>
    Effect.gen(function* () {
      const ops = yield* ComposeSessionOps;
      const startupFailure =
        Exit.isFailure(exit) && !ready ? describeCause(exit.cause) : null;
      yield* ops.publishPhase(request, "stopping", ownedId, startupFailure);
      const teardownFailure = yield* ops
        .composeDown(request.registration.composePath)
        .pipe(
          Effect.as<string | null>(null),
          Effect.catchAll((error) => Effect.succeed(describeCause(error))),
        );
      const failure = startupFailure ?? teardownFailure;
      // A container that outlived teardown keeps its ID in the record: that is
      // what makes the next up refuse the workspace instead of starting a
      // second container over it.
      yield* ops.publishPhase(
        request,
        failure === null ? "stopped" : "failed",
        teardownFailure === null ? null : ownedId,
        failure,
      );
    }).pipe(Effect.catchAll(() => Effect.void));

  return Effect.gen(function* () {
    yield* startup;
    yield* Effect.never;
  }).pipe(Effect.onExit(cleanup));
}

export function makeComposeSessionServiceLive(
  deadlineAt: number,
): Layer.Layer<ComposeSessionService, never, ComposeSessionOps> {
  return Layer.effect(
    ComposeSessionService,
    Effect.gen(function* () {
      const context = yield* Effect.context<ComposeSessionOps>();
      return ComposeSessionService.of({
        serve: (request) =>
          serveComposeSession(request, deadlineAt).pipe(
            Effect.provide(context),
          ),
      });
    }),
  );
}

function effectPromise<A>(
  label: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: fn,
    catch: (e) =>
      new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`),
  });
}

async function runBoundedDocker(
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runDockerCommand(args, { timeoutMs, signal });
  return result.stdout;
}

export function makeComposeSessionOpsLive(
  host: HostEnv,
): Layer.Layer<ComposeSessionOps> {
  return Layer.succeed(
    ComposeSessionOps,
    ComposeSessionOps.of({
      publishCompose: (file, bytes) =>
        effectPromise("publish Compose", () => atomicWriteFile(file, bytes)),
      publishPhase: (request, phase, containerId, diagnostic) =>
        effectPromise("publish devcontainer session", () =>
          withDevcontainerOperationLock(
            host,
            request.registration.workspace,
            async () => {
              const current = await readDevcontainerSession(
                host,
                request.registration.workspace,
              );
              // A later session owns the record once it claims the workspace.
              if (current && current.sessionId !== request.sessionId) return;
              await writeDevcontainerSession(
                host,
                request.registration.workspace,
                {
                  version: 1,
                  workspaceId: request.registration.workspaceId,
                  fingerprint: request.registration.fingerprint,
                  sessionId: request.sessionId,
                  containerId,
                  phase,
                  pid: current?.pid ?? process.pid,
                  diagnostic,
                },
              );
            },
          ),
        ),
      composeUp: (file) =>
        effectPromise("docker compose up", async (signal) => {
          await runBoundedDocker(
            ["compose", "-f", file, "up", "-d"],
            180_000,
            signal,
          );
        }),
      composeContainerId: (file) =>
        effectPromise("docker compose ps", async (signal) =>
          (
            await runBoundedDocker(
              ["compose", "-f", file, "ps", "-q", "agent"],
              10_000,
              signal,
            )
          ).trim(),
        ),
      probeReadyMarker: (id) =>
        effectPromise("docker ready probe", async (signal) => {
          await runBoundedDocker(
            ["exec", id, "test", "-f", READY_MARKER],
            10_000,
            signal,
          );
        }),
      // Teardown runs because the session was interrupted, so it must not
      // inherit the interrupting signal; its 60s deadline is its only bound.
      composeDown: (file) =>
        effectPromise("docker compose down", () =>
          runPreparationTeardown(async () => {
            await runBoundedDocker(["compose", "-f", file, "down"], 60_000);
          }),
        ),
    }),
  );
}
