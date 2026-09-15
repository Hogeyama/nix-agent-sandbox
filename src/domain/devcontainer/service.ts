import * as path from "node:path";
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { getGlobalConfigDir } from "../../config/paths.ts";
import { expandTilde } from "../../lib/fs_utils.ts";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import {
  computeDevcontainerFingerprint,
  renderDevcontainerConfig,
} from "./config.ts";
import {
  pathContains,
  validateDevcontainerMount,
  validateDevcontainerProfile,
} from "./policy.ts";
import {
  type DevcontainerInputs,
  DevcontainerStoreOps,
  devcontainerIo,
  devcontainerWorkspaceId,
  makeDevcontainerStoreOpsLive,
  parseDevcontainerRegistration,
  parseDevcontainerSession,
  requireHostUid,
  resolveDevcontainerPaths,
  resolveDevcontainerRuntimePaths,
} from "./store.ts";
import {
  DevcontainerError,
  type DevcontainerMountPolicy,
  type DevcontainerRegistration,
  type DevcontainerStatus,
  emptyRegistration,
  projectDevcontainerStatus,
} from "./types.ts";

export class DevcontainerService extends Context.Tag("nas/DevcontainerService")<
  DevcontainerService,
  {
    readonly init: (
      workspace: string,
      profileName: string,
    ) => Effect.Effect<DevcontainerRegistration, Error>;
    readonly status: (
      workspace: string,
    ) => Effect.Effect<DevcontainerStatus | null, Error>;
    /** Validate registration and exact inputs before preparing any pipeline resources. */
    readonly verify: (
      workspace: string,
    ) => Effect.Effect<DevcontainerRegistration, Error>;
  }
>() {}

function fail(message: string) {
  return Effect.fail(new DevcontainerError(message));
}
function parse<A>(f: () => A): Effect.Effect<A, Error> {
  return Effect.try({
    try: f,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

/** D2: registration composition. The adapter closes the D1 requirement. */
export function makeDevcontainerServiceLive(
  host: HostEnv,
): Layer.Layer<DevcontainerService, never, DevcontainerStoreOps> {
  return Layer.effect(
    DevcontainerService,
    Effect.gen(function* () {
      const ops = yield* DevcontainerStoreOps;
      const uid = requireHostUid(host);
      const readRegistration = (workspace: string) =>
        Effect.gen(function* () {
          const paths = resolveDevcontainerPaths(host, workspace);
          const bytes = yield* ops.read(paths.registrationFile);
          if (bytes === null) return null;
          const registration = yield* parse(() =>
            parseDevcontainerRegistration(bytes),
          );
          if (
            registration.workspace !== workspace ||
            registration.workspaceId !== devcontainerWorkspaceId(workspace) ||
            registration.configPath !==
              path.join(workspace, ".devcontainer", "devcontainer.json") ||
            registration.composePath !== paths.composeFile ||
            registration.stateRoot !== path.dirname(paths.claudeDir)
          )
            return yield* fail("registration ownership mismatch");
          return registration;
        });
      const readSession = (workspace: string) =>
        Effect.gen(function* () {
          const runtime = resolveDevcontainerRuntimePaths(host, workspace);
          const bytes = yield* ops.read(runtime.sessionFile);
          if (bytes === null) return null;
          const session = yield* parse(() => parseDevcontainerSession(bytes));
          if (
            session.workspaceId !== devcontainerWorkspaceId(workspace) ||
            session.controlSocket !== runtime.controlSocket
          )
            return yield* fail("session ownership mismatch");
          return session;
        });
      const checkOwnership = (
        workspace: string,
        registration: DevcontainerRegistration | null,
      ) =>
        Effect.gen(function* () {
          const configDir = path.join(workspace, ".devcontainer");
          const configFile = path.join(configDir, "devcontainer.json");
          if (yield* ops.stat(path.join(workspace, ".devcontainer.json")))
            return yield* fail(
              "existing .devcontainer.json is not managed by nas",
            );
          const directory = yield* ops.stat(configDir);
          if (!registration) {
            if (directory)
              return yield* fail(
                "existing .devcontainer is not managed by nas",
              );
            return null;
          }
          if (!directory?.isDirectory() || directory.uid !== uid)
            return yield* fail("managed .devcontainer ownership mismatch");
          const entries = yield* ops.list(configDir);
          if (entries.length !== 1 || entries[0] !== "devcontainer.json")
            return yield* fail("existing unregistered files in .devcontainer");
          const bytes = yield* ops.read(configFile);
          const ownerBytes = yield* ops.read(
            path.join(
              resolveDevcontainerPaths(host, workspace).registrationDir,
              "ownership.json",
            ),
          );
          const owner = yield* parse(
            () =>
              JSON.parse(ownerBytes ?? "null") as {
                version?: number;
                configHash?: string;
              } | null,
          );
          if (
            bytes === null ||
            owner?.version !== 1 ||
            owner.configHash !== devcontainerWorkspaceId(bytes)
          )
            return yield* fail(
              "managed devcontainer config was modified; restore it before init",
            );
          return bytes;
        });
      const policyFor = (workspace: string, inputs: DevcontainerInputs) =>
        Effect.gen(function* () {
          const paths = resolveDevcontainerPaths(host, workspace);
          resolveDevcontainerRuntimePaths(host, workspace);
          const home = yield* ops.canonicalSource(host.home);
          const containerHome = `/home/${host.user.trim() || "nas"}`;
          const credentialSources = [
            ".ssh",
            ".gnupg",
            ".aws",
            ".config/gcloud",
            ".config/git",
            ".gitconfig",
            ".git-credentials",
            ".docker",
            ".claude",
            ".claude.json",
          ].map((p) => path.join(host.home, p));
          credentialSources.push("/var/run/docker.sock", "/run/docker.sock");
          const sshSocket = host.env.get("SSH_AUTH_SOCK");
          if (sshSocket) credentialSources.push(sshSocket);
          const dockerHost = host.env.get("DOCKER_HOST");
          if (dockerHost?.startsWith("unix://"))
            credentialSources.push(dockerHost.slice(7));
          const credentialPaths: string[] = [];
          for (const source of credentialSources)
            credentialPaths.push(yield* ops.canonicalSource(source));
          const stateManagement = path.dirname(paths.registrationDir);
          const runtimeManagement = resolveRuntimeSubdir(host, "");
          const hostOnlyPaths = [
            yield* ops.canonicalSource(stateManagement),
            yield* ops.canonicalSource(runtimeManagement),
            yield* ops.canonicalSource(getGlobalConfigDir()),
          ];
          return {
            home,
            credentialPaths,
            hostOnlyPaths,
            protectedTargets: [
              path.join(workspace, ".devcontainer"),
              inputs.configDir,
              path.join(containerHome, ".claude"),
              path.join(containerHome, ".claude.json"),
              path.join(containerHome, ".vscode-server"),
            ],
            dedicatedStateRoot: path.dirname(path.dirname(paths.claudeDir)),
            dedicatedMounts: [
              {
                source: paths.claudeDir,
                target: path.join(containerHome, ".claude"),
              },
              {
                source: paths.claudeJson,
                target: path.join(containerHome, ".claude.json"),
              },
              {
                source: paths.vscodeDir,
                target: path.join(containerHome, ".vscode-server"),
              },
            ],
          } satisfies DevcontainerMountPolicy;
        });
      const validateInputs = (workspace: string, inputs: DevcontainerInputs) =>
        Effect.gen(function* () {
          const errors = [...validateDevcontainerProfile(inputs.profile)];
          const policy = yield* policyFor(workspace, inputs);
          // Workspace itself is an intentional parent of RO entry overlays; source checks still apply.
          errors.push(
            ...validateDevcontainerMount(workspace, workspace, {
              ...policy,
              protectedTargets: [],
            }),
          );
          for (const mount of inputs.profile.extraMounts) {
            const raw = path.resolve(
              workspace,
              expandTilde(mount.src, host.home),
            );
            const source = yield* ops.canonicalSource(raw);
            errors.push(
              ...validateDevcontainerMount(source, mount.dst, policy).map(
                (e) => `extraMounts: ${e}`,
              ),
            );
            // An alias of the workspace/entry file circumvents the RO overlay at its normal target.
            if (
              pathContains(source, path.join(workspace, ".devcontainer")) ||
              pathContains(source, inputs.configDir) ||
              pathContains(path.join(workspace, ".devcontainer"), source) ||
              pathContains(inputs.configDir, source)
            )
              errors.push(
                "extraMounts: source exposes a protected configuration through an alias",
              );
          }
          if (errors.length) return yield* fail(errors.join("\n"));
        });
      const withLock = <A>(
        workspace: string,
        body: () => Effect.Effect<A, Error>,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              ops.lock(resolveDevcontainerPaths(host, workspace).operationLock),
              (handle) =>
                devcontainerIo(handle.release).pipe(
                  Effect.catchAll(() =>
                    Effect.logWarning("devcontainer lock close failed"),
                  ),
                ),
            );
            return yield* body();
          }),
        );
      return DevcontainerService.of({
        init: (requested, profileName) =>
          Effect.gen(function* () {
            const workspace = yield* ops.canonicalize(requested);
            return yield* withLock(workspace, () =>
              Effect.gen(function* () {
                const paths = resolveDevcontainerPaths(host, workspace);
                const registration = yield* readRegistration(workspace);
                const oldConfig = yield* checkOwnership(
                  workspace,
                  registration,
                );
                if (
                  !registration &&
                  (yield* ops.stat(path.dirname(paths.claudeDir)))
                )
                  return yield* fail("existing unregistered dedicated state");
                const session = yield* readSession(workspace);
                if (
                  session &&
                  (session.phase !== "stopped" || session.containerId !== null)
                )
                  return yield* fail(
                    "session must be confirmed stopped before init; run devcontainer down",
                  );
                const inputs = yield* ops.inputs(workspace, profileName);
                yield* validateInputs(workspace, inputs);
                const configDir = path.join(workspace, ".devcontainer");
                const ownershipFile = path.join(
                  paths.registrationDir,
                  "ownership.json",
                );
                const oldOwnership = yield* ops.read(ownershipFile);
                const oldRegistration = yield* ops.read(paths.registrationFile);
                if (!registration && oldOwnership !== null)
                  return yield* fail("existing unregistered ownership file");
                const record: DevcontainerRegistration = {
                  version: 1,
                  workspaceId: devcontainerWorkspaceId(workspace),
                  workspace,
                  profileName: inputs.profileName,
                  fingerprint: "",
                  configPath: path.join(configDir, "devcontainer.json"),
                  composePath: paths.composeFile,
                  stateRoot: path.dirname(paths.claudeDir),
                  command: inputs.command,
                };
                const bytes = `${JSON.stringify(renderDevcontainerConfig(record, host.user.trim() || "nas"), null, 2)}\n`;
                const complete = {
                  ...record,
                  fingerprint: computeDevcontainerFingerprint(
                    bytes,
                    inputs,
                    host,
                  ),
                };
                const undo: Array<Effect.Effect<unknown, Error>> = [];
                const createDir = (dir: string) =>
                  Effect.gen(function* () {
                    if (yield* ops.directory(dir))
                      undo.push(ops.remove(dir, true));
                  }).pipe(Effect.uninterruptible);
                const write = (
                  file: string,
                  contents: string,
                  previous: string | null,
                ) =>
                  Effect.gen(function* () {
                    yield* ops.write(file, contents, previous === null);
                    undo.push(
                      previous === null
                        ? ops.remove(file)
                        : ops.write(file, previous),
                    );
                  }).pipe(Effect.uninterruptible);
                const publish = Effect.gen(function* () {
                  yield* createDir(record.stateRoot);
                  yield* createDir(paths.claudeDir);
                  yield* createDir(paths.vscodeDir);
                  const existingClaude = yield* ops.read(paths.claudeJson);
                  if (existingClaude === null)
                    yield* write(paths.claudeJson, "{}\n", null);
                  yield* createDir(configDir);
                  yield* write(record.configPath, bytes, oldConfig);
                  yield* write(
                    ownershipFile,
                    `${JSON.stringify({ version: 1, configHash: devcontainerWorkspaceId(bytes) })}\n`,
                    oldOwnership,
                  );
                  yield* write(
                    paths.registrationFile,
                    `${JSON.stringify(complete, null, 2)}\n`,
                    oldRegistration,
                  );
                  return complete;
                });
                return yield* publish.pipe(
                  Effect.onError(() =>
                    Effect.forEach(
                      [...undo].reverse(),
                      (effect) =>
                        effect.pipe(
                          Effect.catchAll(() =>
                            Effect.logWarning(
                              "devcontainer init rollback incomplete",
                            ),
                          ),
                        ),
                      { discard: true },
                    ),
                  ),
                );
              }),
            );
          }),
        status: (requested) =>
          Effect.gen(function* () {
            const workspace = yield* ops.canonicalize(requested);
            const registration = yield* readRegistration(workspace);
            if (!registration) return null;
            return projectDevcontainerStatus(
              registration,
              yield* readSession(workspace),
            );
          }),
        verify: (requested) =>
          Effect.gen(function* () {
            const workspace = yield* ops.canonicalize(requested);
            const registration = yield* readRegistration(workspace);
            if (!registration)
              return yield* fail(
                "workspace is not registered; run devcontainer init",
              );
            const bytes = yield* checkOwnership(workspace, registration);
            const inputs = yield* ops.inputs(
              workspace,
              registration.profileName,
            );
            yield* validateInputs(workspace, inputs);
            if (
              bytes === null ||
              computeDevcontainerFingerprint(bytes, inputs, host) !==
                registration.fingerprint
            )
              return yield* fail(
                "devcontainer fingerprint changed; stop the session and run init again",
              );
            return registration;
          }),
      });
    }),
  );
}
export type DevcontainerServiceFakeConfig = Partial<
  Context.Tag.Service<DevcontainerService>
>;
export function makeDevcontainerServiceFake(
  overrides: DevcontainerServiceFakeConfig = {},
): Layer.Layer<DevcontainerService> {
  return Layer.succeed(
    DevcontainerService,
    DevcontainerService.of({
      init: (workspace, profileName) =>
        Effect.succeed(emptyRegistration(workspace, profileName)),
      status: () => Effect.succeed(null),
      verify: (workspace) => Effect.succeed(emptyRegistration(workspace, "")),
      ...overrides,
    }),
  );
}
export function makeDevcontainerClient(
  host: HostEnv,
  layer: Layer.Layer<
    DevcontainerService,
    never,
    DevcontainerStoreOps
  > = makeDevcontainerServiceLive(host),
) {
  const provided: Layer.Layer<DevcontainerService> = layer.pipe(
    Layer.provide(makeDevcontainerStoreOpsLive(host)),
  );
  async function run<A>(
    f: (
      service: Context.Tag.Service<DevcontainerService>,
    ) => Effect.Effect<A, Error>,
  ): Promise<A> {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(DevcontainerService, f).pipe(Effect.provide(provided)),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    throw new Error(`Defect or interruption: ${Cause.pretty(exit.cause)}`);
  }
  return {
    init: (workspace: string, profileName: string) =>
      run((s) => s.init(workspace, profileName)),
    status: (workspace: string) => run((s) => s.status(workspace)),
    verify: (workspace: string) => run((s) => s.verify(workspace)),
  };
}
