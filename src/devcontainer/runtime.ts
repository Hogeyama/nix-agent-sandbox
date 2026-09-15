import * as path from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
import { createCliInitialState } from "../cli/pipeline_state.ts";
import type { Config, Profile } from "../config/types.ts";
import type { DevcontainerRegistration } from "../domain/devcontainer.ts";
import {
  pathsOverlap,
  resolveDevcontainerPaths,
} from "../domain/devcontainer.ts";
import { checkNotifySend, resolveNotifyBackend } from "../lib/notify_utils.ts";
import { resolveRuntimeSubdir } from "../lib/runtime_dir.ts";
import { createPreparationPipelineBuilder } from "../pipeline/cli_builder.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import { createPipelineLiveLayer } from "../pipeline/live.ts";
import type { HostEnv } from "../pipeline/types.ts";
import { DockerServiceLive } from "../services/docker.ts";
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
  const probes = await resolveProbes(host);
  const mountProbes = await resolveMountProbes(
    host,
    options.profile,
    workspace,
    probes.gpgAgentSocket,
  );
  const gitMetadataPaths = await resolveDevcontainerGitMetadata(workspace);
  validateOriginalMountRoots(host, options.registration, gitMetadataPaths);
  const buildProbes = await resolveBuildProbes("nas-sandbox");

  const networkNotify = resolveNotifyBackend(
    options.profile.network.pendingNotify,
  );
  const hostexecNotify = resolveNotifyBackend(
    options.profile.hostexec?.prompt.notify ?? "auto",
  );
  if (networkNotify === "desktop" || hostexecNotify === "desktop")
    checkNotifySend();
  if (options.config.ui.enable) {
    await ensureUiDaemon({
      port: options.config.ui.port,
      idleTimeout: options.config.ui.idleTimeout,
    });
  }
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
  const builder = createPreparationPipelineBuilder({
    input,
    buildProbes,
    mountProbes,
    devcontainerMounts: {
      claudeDir: paths.claudeDir,
      claudeJson: paths.claudeJson,
      vscodeDir: paths.vscodeDir,
      gitMetadataPaths,
    },
  }).add(createComposeStage(input, { registration: options.registration }));

  const opsLayer = makeComposeSessionOpsLive(host).pipe(
    Layer.provide(DockerServiceLive),
  );
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
    yield* builder
      .run(
        createCliInitialState(workspace, "nas-sandbox", {
          NAS_SESSION_ID: options.sessionId,
        }),
      )
      .pipe(Effect.provide(composeLayer));
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
