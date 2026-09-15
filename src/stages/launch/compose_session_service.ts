import { connect } from "node:net";
import { Cause, Context, Effect, Exit, Layer, Schedule } from "effect";
import { runDockerCommand } from "../../docker/client.ts";
import {
  decodeDockerLaunchImage,
  decodeDockerLaunchInspection,
} from "../../docker/launch_inspection.ts";
import { NAS_SESSION_ID_LABEL } from "../../docker/nas_resources.ts";
import type {
  DevcontainerRegistration,
  DevcontainerSessionRecord,
} from "../../domain/devcontainer.ts";
import {
  pathsOverlap,
  readDevcontainerSession,
  requireHostUid,
  resolveDevcontainerRuntimePaths,
  withDevcontainerOperationLock,
  writeDevcontainerSession,
  writeProtectedFile,
} from "../../domain/devcontainer.ts";
import { hostExecBrokerSocketPath } from "../../hostexec/registry.ts";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { brokerSocketPath } from "../../network/registry.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import type {
  DockerLaunchImage,
  DockerLaunchInspection,
} from "../../services/docker.ts";
import { compileCompose, serializeCompose } from "./compose.ts";
import { compareLaunchInspection } from "./inspection.ts";

const READY_MARKER = "/run/nas-devcontainer/ready";
const POLL_MS = 500;

export interface ComposeSessionRequest {
  readonly registration: DevcontainerRegistration;
  readonly sessionId: string;
  readonly containerName: string;
  readonly container: ContainerPlan;
}

export interface ComposeSessionServiceApi {
  /** Remains alive after ready until interrupted or a required resource fails. */
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
    readonly validate: (
      request: ComposeSessionRequest,
    ) => Effect.Effect<void, Error>;
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
    readonly finalizeStopped: (
      request: ComposeSessionRequest,
    ) => Effect.Effect<void, Error>;
    readonly composeUp: (path: string) => Effect.Effect<void, Error>;
    readonly composeContainerId: (path: string) => Effect.Effect<string, Error>;
    readonly inspectImage: (
      reference: string,
    ) => Effect.Effect<DockerLaunchImage, Error>;
    readonly probeReadyMarker: (id: string) => Effect.Effect<void, Error>;
    readonly inspect: (
      id: string,
    ) => Effect.Effect<DockerLaunchInspection, Error>;
    readonly probeUser: (
      id: string,
      uid: number,
      home: string,
      workspace: string,
    ) => Effect.Effect<void, Error>;
    readonly probeNetworkBroker: (
      sessionId: string,
    ) => Effect.Effect<void, Error>;
    readonly probeHostExecBroker: (
      sessionId: string,
    ) => Effect.Effect<void, Error>;
    readonly probeContainerGateways: (id: string) => Effect.Effect<void, Error>;
    readonly waitForMonitorTick: () => Effect.Effect<void, Error>;
    readonly stop: (id: string) => Effect.Effect<void, Error>;
    readonly remove: (id: string) => Effect.Effect<void, Error>;
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

function projectName(request: ComposeSessionRequest): string {
  return `nas-devcontainer-${request.registration.workspaceId.slice(0, 24)}`;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export function validateComposeSessionRequest(
  request: ComposeSessionRequest,
  hostHome?: string,
): void {
  if (request.registration.workspace !== request.container.workDir)
    throw new Error(
      "devcontainer workspace differs from the launch working directory",
    );
  if (request.container.labels[NAS_SESSION_ID_LABEL] !== request.sessionId)
    throw new Error("devcontainer session label differs");
  if (
    request.container.labels["devcontainer.local_folder"] !==
    request.registration.workspace
  )
    throw new Error("devcontainer workspace label differs");
  if (
    request.container.labels["devcontainer.config_file"] !==
    request.registration.configPath
  )
    throw new Error("devcontainer config label differs");
  const user = request.container.env.static.NAS_USER?.trim() || "nas";
  const requiredMounts = [
    {
      source: hostHome
        ? `${hostHome}/.claude`
        : `${request.registration.stateRoot}/claude`,
      target: `/home/${user}/.claude`,
      readOnly: false,
    },
    {
      source: hostHome
        ? `${hostHome}/.claude.json`
        : `${request.registration.stateRoot}/claude.json`,
      target: `/home/${user}/.claude.json`,
      readOnly: false,
    },
    {
      source: `${request.registration.stateRoot}/vscode`,
      target: `/home/${user}/.vscode-server`,
      readOnly: false,
    },
  ];
  for (const required of requiredMounts) {
    const matches = request.container.mounts.filter(
      (mount) =>
        mount.source === required.source &&
        mount.target === required.target &&
        (mount.readOnly ?? false) === required.readOnly,
    );
    if (matches.length !== 1)
      throw new Error(`required dedicated mount differs: ${required.target}`);
  }
  for (const mount of request.container.mounts) {
    if (
      pathsOverlap(mount.source, request.registration.stateRoot) &&
      !requiredMounts.some(
        (required) =>
          mount.source === required.source &&
          mount.target === required.target &&
          (mount.readOnly ?? false) === required.readOnly,
      )
    )
      throw new Error("dedicated state mount is not a registered pair");
  }
  const workspaceMount = request.container.mounts.find(
    (mount) => mount.target === request.registration.workspace,
  );
  if (!workspaceMount || workspaceMount.readOnly)
    throw new Error("writable workspace mount is missing");
  const protectedTargets = [
    request.registration.configPath.slice(
      0,
      request.registration.configPath.lastIndexOf("/"),
    ),
    `${request.registration.workspace}/.nas`,
  ];
  for (const target of protectedTargets) {
    const exactOverlays = request.container.mounts.filter(
      (mount) => mount.target === target && mount.readOnly === true,
    );
    if (exactOverlays.length !== 1)
      throw new Error(`read-only configuration overlay is missing: ${target}`);
  }
  const protectedMountTargets = [
    ...protectedTargets,
    ...requiredMounts.map((mount) => mount.target),
  ];
  for (const mount of request.container.mounts) {
    if (
      (mount.readOnly ?? false) === false &&
      protectedMountTargets.some((target) =>
        pathContains(target, mount.target),
      ) &&
      !requiredMounts.some(
        (required) =>
          mount.source === required.source &&
          mount.target === required.target &&
          (mount.readOnly ?? false) === required.readOnly,
      )
    )
      throw new Error(
        `writable mount overrides a protected target: ${mount.target}`,
      );
  }
  if (
    request.container.mounts.some(
      (mount) =>
        mount.source === request.registration.composePath ||
        mount.source.endsWith(`/brokers/${request.sessionId}/sock`) ||
        mount.source === "/var/run/docker.sock" ||
        mount.source === "/run/docker.sock",
    )
  )
    throw new Error("host-only control path is mounted into the container");
  compileCompose(
    request.container,
    request.containerName,
    projectName(request),
  );
}

export class ComposeStopRequested extends Error {}

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
  let composeAttempted = false;
  let startupComplete = false;
  const startup = Effect.gen(function* () {
    const ops = yield* ComposeSessionOps;
    yield* ops.validate(request);
    const document = compileCompose(
      request.container,
      request.containerName,
      projectName(request),
    );
    const expectedImage = yield* ops.inspectImage(request.container.image);
    yield* ops.publishCompose(
      request.registration.composePath,
      serializeCompose(document),
    );
    yield* ops.publishPhase(request, "starting", null, null);
    composeAttempted = true;
    const started = yield* Effect.exit(
      ops.composeUp(request.registration.composePath),
    );
    const discovered = yield* Effect.exit(
      ops.composeContainerId(request.registration.composePath),
    );
    if (Exit.isSuccess(discovered) && discovered.value)
      ownedId = discovered.value;
    if (Exit.isFailure(started))
      return yield* Effect.fail(new Error(describeCause(started.cause)));
    if (Exit.isFailure(discovered))
      return yield* Effect.fail(new Error(describeCause(discovered.cause)));
    if (!ownedId)
      return yield* Effect.fail(
        new Error("Compose did not return a container ID"),
      );
    yield* ops
      .probeReadyMarker(ownedId)
      .pipe(Effect.retry(Schedule.spaced("100 millis")));
    const actual = yield* ops.inspect(ownedId);
    const diagnostics = compareLaunchInspection(
      {
        containerId: ownedId,
        container: request.container,
        image: expectedImage,
        command: [
          "/usr/local/bin/nas-devcontainer-idle",
          ...request.container.command.extraArgs,
        ],
      },
      actual,
    );
    if (diagnostics.length)
      return yield* Effect.fail(new Error(diagnostics.join("; ")));
    const uid = Number(request.container.env.static.NAS_UID);
    if (!Number.isSafeInteger(uid) || uid <= 0)
      return yield* Effect.fail(new Error("invalid non-root readiness UID"));
    const user = request.container.env.static.NAS_USER?.trim() || "nas";
    yield* ops.probeUser(
      ownedId,
      uid,
      `/home/${user}`,
      request.registration.workspace,
    );
    yield* ops.probeNetworkBroker(request.sessionId);
    yield* ops.probeHostExecBroker(request.sessionId);
    yield* ops.probeContainerGateways(ownedId);
    yield* ops.publishPhase(request, "ready", ownedId, null);
    startupComplete = true;
  }).pipe(
    Effect.timeoutFail({
      duration: Math.max(0, deadlineAt - Date.now()),
      onTimeout: () => new Error("devcontainer startup deadline exceeded"),
    }),
  );

  const cleanup = (exit: Exit.Exit<void, Error>) =>
    Effect.gen(function* () {
      const ops = yield* ComposeSessionOps;
      const normalReadyInterruption =
        startupComplete &&
        Exit.isFailure(exit) &&
        Cause.isInterruptedOnly(exit.cause);
      const original =
        Exit.isFailure(exit) && !normalReadyInterruption
          ? describeCause(exit.cause)
          : null;
      const cleanupErrors: string[] = [];
      if (ownedId === null && composeAttempted) {
        const discovered = yield* Effect.exit(
          ops.composeContainerId(request.registration.composePath),
        );
        if (Exit.isSuccess(discovered) && discovered.value) {
          ownedId = discovered.value;
        } else if (Exit.isFailure(discovered)) {
          cleanupErrors.push(
            `container discovery failed: ${describeCause(discovered.cause)}`,
          );
        }
      }
      if (ownedId !== null) {
        const stoppingPublished = yield* Effect.exit(
          ops.publishPhase(request, "stopping", ownedId, original),
        );
        if (Exit.isFailure(stoppingPublished))
          cleanupErrors.push(
            `stopping state publish failed: ${describeCause(stoppingPublished.cause)}`,
          );
        const current = yield* Effect.exit(ops.inspect(ownedId));
        if (Exit.isFailure(current)) {
          cleanupErrors.push(
            `ownership inspection failed: ${describeCause(current.cause)}`,
          );
        } else if (
          current.value.id !== ownedId ||
          current.value.labels[NAS_SESSION_ID_LABEL] !== request.sessionId ||
          current.value.labels["devcontainer.local_folder"] !==
            request.registration.workspace
        ) {
          cleanupErrors.push("owned container identity changed before cleanup");
        } else {
          const stopped = yield* Effect.exit(ops.stop(ownedId));
          if (Exit.isFailure(stopped))
            cleanupErrors.push(`stop failed: ${describeCause(stopped.cause)}`);
          const removed = yield* Effect.exit(ops.remove(ownedId));
          if (Exit.isFailure(removed))
            cleanupErrors.push(
              `remove failed: ${describeCause(removed.cause)}`,
            );
        }
      }
      if (original !== null || cleanupErrors.length > 0 || !startupComplete) {
        const diagnostic =
          [original, ...cleanupErrors].filter(Boolean).join("; ") ||
          "startup failed";
        yield* ops.publishPhase(request, "failed", ownedId, diagnostic);
      } else {
        yield* ops.publishPhase(request, "stopping", null, null);
      }
    }).pipe(Effect.catchAll(() => Effect.void));

  return Effect.gen(function* () {
    const ops = yield* ComposeSessionOps;
    yield* startup;
    const monitoredId = ownedId;
    if (monitoredId === null)
      return yield* Effect.fail(
        new Error("Compose container ID was lost after readiness"),
      );
    yield* Effect.forever(
      ops.waitForMonitorTick().pipe(
        Effect.catchIf(
          (error) => error instanceof ComposeStopRequested,
          () => Effect.fail(new ComposeStopRequested()),
        ),
        Effect.andThen(ops.inspect(monitoredId)),
        Effect.flatMap((actual) =>
          actual.id === monitoredId &&
          actual.running &&
          actual.labels[NAS_SESSION_ID_LABEL] === request.sessionId
            ? Effect.void
            : Effect.fail(new Error("devcontainer stopped or was replaced")),
        ),
        Effect.andThen(ops.probeNetworkBroker(request.sessionId)),
        Effect.andThen(ops.probeHostExecBroker(request.sessionId)),
        Effect.andThen(ops.probeContainerGateways(monitoredId)),
      ),
    ).pipe(
      Effect.catchIf(
        (error) => error instanceof ComposeStopRequested,
        () => Effect.void,
      ),
    );
  }).pipe(Effect.onExit(cleanup));
}

/** Register before preparation so this finalizer runs after broker finalizers. */
export function completeComposeSession(
  request: ComposeSessionRequest,
): Effect.Effect<void, never, ComposeSessionOps> {
  return Effect.gen(function* () {
    const ops = yield* ComposeSessionOps;
    yield* ops
      .finalizeStopped(request)
      .pipe(Effect.catchAll(() => Effect.void));
  });
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
  return Buffer.from(result.stdout).toString();
}

async function probeJsonSocket(
  socketPath: string,
  expectedType: string,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let bytes = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error("broker health probe aborted"));
    timer = setTimeout(
      () => finish(new Error("broker health probe timed out")),
      2_000,
    );
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      bytes += chunk.toString("utf8");
      const newline = bytes.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(bytes.slice(0, newline)) as { type?: unknown };
        if (value.type !== expectedType)
          throw new Error("unexpected broker health response");
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("connect", () => socket.write('{"type":"list_pending"}\n'));
  });
}

export function makeComposeSessionOpsLive(
  host: HostEnv,
): Layer.Layer<ComposeSessionOps> {
  return Layer.effect(
    ComposeSessionOps,
    Effect.gen(function* () {
      const uid = requireHostUid(host);
      const networkRoot = resolveRuntimeSubdir(host, "network");
      const hostexecRoot = resolveRuntimeSubdir(host, "hostexec");
      const pathSet = (runtimeDir: string) => ({
        runtimeDir,
        sessionsDir: `${runtimeDir}/sessions`,
        pendingDir: `${runtimeDir}/pending`,
        brokersDir: `${runtimeDir}/brokers`,
      });
      const publishPhase = (
        request: ComposeSessionRequest,
        phase: Phase,
        containerId: string | null,
        diagnostic: string | null,
      ) =>
        effectPromise("publish devcontainer session", () =>
          withDevcontainerOperationLock(
            host,
            request.registration.workspace,
            () =>
              writeDevcontainerSession(
                host,
                request.registration.workspace,
                {
                  version: 1,
                  workspaceId: request.registration.workspaceId,
                  fingerprint: request.registration.fingerprint,
                  sessionId: request.sessionId,
                  containerId,
                  phase,
                  controlSocket: resolveDevcontainerRuntimePaths(
                    host,
                    request.registration.workspace,
                  ).controlSocket,
                  diagnostic,
                },
                request.sessionId,
              ),
          ),
        );
      return ComposeSessionOps.of({
        validate: (request) =>
          Effect.try({
            try: () => validateComposeSessionRequest(request, host.home),
            catch: (e) => e as Error,
          }),
        publishCompose: (file, bytes) =>
          effectPromise("publish Compose", () =>
            writeProtectedFile(file, bytes, uid),
          ),
        publishPhase,
        finalizeStopped: (request) =>
          effectPromise("finalize devcontainer session", () =>
            withDevcontainerOperationLock(
              host,
              request.registration.workspace,
              async () => {
                const current = await readDevcontainerSession(
                  host,
                  request.registration.workspace,
                );
                if (
                  current?.sessionId !== request.sessionId ||
                  current.phase !== "stopping" ||
                  current.containerId !== null
                )
                  return;
                await writeDevcontainerSession(
                  host,
                  request.registration.workspace,
                  { ...current, phase: "stopped", diagnostic: null },
                  request.sessionId,
                );
              },
            ),
          ),
        composeUp: (file) =>
          effectPromise("docker compose up", async (signal) => {
            await runBoundedDocker(
              ["compose", "-f", file, "up", "-d"],
              30_000,
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
        inspectImage: (reference) =>
          effectPromise("docker launch image inspect", async (signal) => {
            const json = await runBoundedDocker(
              ["image", "inspect", reference],
              10_000,
              signal,
            );
            return decodeDockerLaunchImage(JSON.parse(json));
          }),
        probeReadyMarker: (id) =>
          effectPromise("docker ready probe", async (signal) => {
            await runBoundedDocker(
              ["exec", id, "test", "-f", READY_MARKER],
              10_000,
              signal,
            );
          }),
        inspect: (id) =>
          effectPromise("docker launch inspect", async (signal) => {
            const json = await runBoundedDocker(
              ["inspect", id],
              10_000,
              signal,
            );
            return decodeDockerLaunchInspection(JSON.parse(json));
          }),
        probeUser: (id, expectedUid, expectedHome, workspace) =>
          effectPromise("docker user probe", async (signal) => {
            const out = await runBoundedDocker(
              [
                "exec",
                "-u",
                String(expectedUid),
                id,
                "/usr/local/bin/nas-devcontainer-exec",
                "/bin/sh",
                "-c",
                'printf \'%s\\n%s\\n%s\\n\' "$(id -u)" "$HOME" "$PWD"',
              ],
              10_000,
              signal,
            );
            if (
              out.trimEnd() !== `${expectedUid}\n${expectedHome}\n${workspace}`
            )
              throw new Error("non-root launcher readiness differs");
          }),
        probeNetworkBroker: (sessionId) =>
          effectPromise("network broker health", (signal) =>
            probeJsonSocket(
              brokerSocketPath(pathSet(networkRoot), sessionId),
              "pending",
              signal,
            ),
          ),
        probeHostExecBroker: (sessionId) =>
          effectPromise("hostexec broker health", (signal) =>
            probeJsonSocket(
              hostExecBrokerSocketPath(pathSet(hostexecRoot), sessionId),
              "pending",
              signal,
            ),
          ),
        probeContainerGateways: (id) =>
          effectPromise("docker gateway probe", async (signal) => {
            await runBoundedDocker(
              [
                "exec",
                "-u",
                String(uid),
                id,
                "/usr/local/bin/nas-devcontainer-exec",
                "bun",
                "-e",
                "const proxy=new URL(process.env.http_proxy); const open=(o)=>new Promise((ok,no)=>{const t=setTimeout(()=>no(Error('timeout')),2000); Bun.connect({...o,socket:{open(s){clearTimeout(t);s.end();ok()},data(){},close(){},error(_,e){clearTimeout(t);no(e)}}}).catch(no)}); await open({hostname:proxy.hostname,port:Number(proxy.port)}); await open({unix:process.env.NAS_HOSTEXEC_SOCKET});",
              ],
              10_000,
              signal,
            );
          }),
        waitForMonitorTick: () => Effect.sleep(POLL_MS),
        stop: (id) =>
          effectPromise("docker stop", async (signal) => {
            await runBoundedDocker(["stop", id], 15_000, signal);
          }),
        remove: (id) =>
          effectPromise("docker rm", async (signal) => {
            await runBoundedDocker(["rm", id], 10_000, signal);
          }),
      });
    }),
  );
}
