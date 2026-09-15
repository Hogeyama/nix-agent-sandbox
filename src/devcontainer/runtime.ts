import * as path from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
import { createCliInitialState } from "../cli/pipeline_state.ts";
import { loadConfig, resolveProfile } from "../config/load.ts";
import type { Config, Profile } from "../config/types.ts";
import type { DevcontainerRegistration } from "../domain/devcontainer.ts";
import {
  pathsOverlap,
  resolveDevcontainerPaths,
  serveDevcontainerSupervisor,
} from "../domain/devcontainer.ts";
import { checkNotifySend, resolveNotifyBackend } from "../lib/notify_utils.ts";
import { resolveRuntimeSubdir } from "../lib/runtime_dir.ts";
import { createPreparationPipelineBuilder } from "../pipeline/cli_builder.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import { createPipelineLiveLayer } from "../pipeline/live.ts";
import type { HostEnv } from "../pipeline/types.ts";
import { resolveBuildProbes } from "../stages/docker_build.ts";
import {
  ComposeSessionOps,
  type ComposeSessionRequest,
  ComposeSessionService,
  completeComposeSession,
  createComposeStage,
  makeComposeSessionOpsLive,
  serveComposeSession,
} from "../stages/launch.ts";
import {
  resolveDevcontainerGitMetadata,
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
  readonly host?: HostEnv;
}

export interface DevcontainerRuntimeResult {
  readonly exit: Exit.Exit<void, Error>;
  readonly containerName: string | null;
}

/** Application dispatch for the private detached `_supervise` CLI entry. */
export async function runDevcontainerSupervisorEntry(
  workspace: string,
  sessionId: string,
): Promise<void> {
  const host = buildHostEnv();
  await serveDevcontainerSupervisor({
    host,
    workspace,
    sessionId,
    runRuntime: async (registration, signal) => {
      const config = await loadConfig({ startDir: registration.workspace });
      const resolved = resolveProfile(config, registration.profileName);
      const result = await runDevcontainerRuntime({
        registration,
        config,
        profile: resolved.profile,
        sessionId,
        signal,
        host,
      });
      return Exit.isSuccess(result.exit)
        ? { ok: true }
        : {
            ok: false,
            diagnostic: `devcontainer runtime failed: ${Cause.pretty(result.exit.cause).split("\n", 1)[0]}`,
          };
    },
  });
}

/**
 * Application boundary used by the detached supervisor.
 *
 * It resolves host probes, supplies UI/notification support, runs one scoped
 * preparation pipeline, and keeps that scope alive through ComposeSessionService.
 * Passing the supervisor AbortSignal interrupts the Effect and waits for all
 * container and broker finalizers before this promise resolves.
 */
export async function runDevcontainerRuntime(
  options: DevcontainerRuntimeOptions,
): Promise<DevcontainerRuntimeResult> {
  const deadlineAt = Date.now() + (options.startupTimeoutMs ?? 120_000);
  const host = options.host ?? buildHostEnv();
  const workspace = options.registration.workspace;
  const guard = createStartupGuard(deadlineAt, options.signal);
  const { probes, mountProbes, gitMetadataPaths, buildProbes } =
    await (async () => {
      try {
        const probes = await guard.wait(resolveProbes(host));
        const mountProbes = await guard.wait(
          resolveMountProbes(
            host,
            options.profile,
            workspace,
            probes.gpgAgentSocket,
          ),
        );
        const gitMetadataPaths = await guard.wait(
          resolveDevcontainerGitMetadata(workspace),
        );
        validateOriginalMountRoots(
          host,
          options.registration,
          gitMetadataPaths,
        );
        const buildProbes = await guard.wait(
          resolveBuildProbes("nas-sandbox", {
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
        return { probes, mountProbes, gitMetadataPaths, buildProbes };
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
      claudeDir: path.join(host.home, ".claude"),
      claudeJson: path.join(host.home, ".claude.json"),
      vscodeDir: paths.vscodeDir,
      gitMetadataPaths,
    },
  });
  const composeStage = createComposeStage(input, {
    registration: options.registration,
  });

  const opsLayer = makeComposeSessionOpsLive(host);
  let request: ComposeSessionRequest | null = null;
  let containerName: string | null = null;
  const program = Effect.gen(function* () {
    const ops = yield* ComposeSessionOps;
    yield* Effect.addFinalizer(() =>
      request === null ? Effect.void : completeComposeSession(request),
    );
    const composeLayer = Layer.succeed(
      ComposeSessionService,
      ComposeSessionService.of({
        serve: (next) => {
          request = next;
          containerName = next.containerName;
          return serveComposeSession(next, deadlineAt).pipe(
            Effect.provide(Layer.succeed(ComposeSessionOps, ops)),
          );
        },
      }),
    );
    const prepared = yield* preparationBuilder
      .run(
        createCliInitialState(workspace, "nas-sandbox", {
          NAS_SESSION_ID: options.sessionId,
        }),
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

  const exit = await Effect.runPromiseExit(
    program,
    options.signal ? { signal: options.signal } : undefined,
  );
  const normalized: Exit.Exit<void, Error> = Exit.isSuccess(exit)
    ? Exit.succeed(undefined)
    : Exit.fail(new Error(Cause.pretty(exit.cause)));
  return { exit: normalized, containerName };
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

function validateOriginalMountRoots(
  host: HostEnv,
  registration: DevcontainerRegistration,
  gitMetadataPaths: readonly string[],
): void {
  const protectedRoot = path.dirname(path.dirname(registration.stateRoot));
  const protectedPaths = [
    path.join(host.home, ".ssh"),
    path.join(host.home, ".gnupg"),
    path.join(host.home, ".aws"),
    path.join(host.home, ".config", "gcloud"),
    path.join(host.home, ".docker"),
    "/var/run/docker.sock",
    "/run/docker.sock",
    protectedRoot,
    resolveRuntimeSubdir(host, ""),
  ];
  for (const source of [registration.workspace, ...gitMetadataPaths]) {
    if (source === host.home || source === path.dirname(host.home))
      throw new Error("devcontainer workspace must not expose host HOME");
    if (
      protectedPaths.some((protectedPath) =>
        pathsOverlap(source, protectedPath),
      )
    )
      throw new Error(
        "devcontainer mount source exposes a protected host path",
      );
  }
}
