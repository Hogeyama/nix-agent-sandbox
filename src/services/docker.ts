/**
 * DockerService — Effect-based abstraction over Docker CLI operations.
 *
 * Live implementation delegates to existing functions in src/docker/client.ts.
 * Fake implementation provides configurable stubs for testing.
 *
 * Live methods expose `Effect.Effect<T, Error>` (no `.orDie`). Stage code that
 * wants to die on Docker failures wraps individual calls with `.pipe(Effect.orDie)`.
 * Domain services that want to surface error channels (UI/HTTP) consume the
 * raw Effect directly.
 */

import { Context, Effect, Layer } from "effect";
import {
  type DockerContainerDetails,
  type DockerNetworkDetails,
  type DockerVolumeDetails,
  dockerBuild,
  dockerContainerExists,
  dockerContainerIp,
  dockerExec,
  dockerInspectContainer,
  dockerInspectNetwork,
  dockerInspectVolume,
  dockerIsRunning,
  dockerListContainerNames,
  dockerListNetworkNames,
  dockerListVolumeNames,
  dockerLogs,
  dockerNetworkConnect,
  dockerNetworkCreateWithLabels,
  dockerNetworkDisconnect,
  dockerNetworkRemove,
  dockerRm,
  dockerRun,
  dockerRunDetached,
  dockerStop,
  dockerVolumeCreate,
  dockerVolumeRemove,
} from "../docker/client.ts";

// Re-export so domain services depending on DockerService can import the
// detail types from the same module without reaching into docker/client.ts.
export type {
  DockerContainerDetails,
  DockerNetworkDetails,
  DockerVolumeDetails,
} from "../docker/client.ts";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface DockerRunOpts {
  readonly image: string;
  readonly name?: string;
  readonly args: string[];
  readonly envVars: Record<string, string>;
  readonly command: string[];
  readonly labels?: Record<string, string>;
}

export interface DockerRunDetachedOpts {
  readonly name: string;
  readonly image: string;
  readonly args: string[];
  readonly envVars: Record<string, string>;
  readonly network?: string;
  readonly mounts?: Array<
    | string
    | {
        source: string;
        target: string;
        mode?: string;
        type?: "bind" | "volume";
      }
  >;
  readonly publishedPorts?: string[];
  readonly labels?: Record<string, string>;
  readonly entrypoint?: string;
  readonly command?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function wrapError(prefix: string): (e: unknown) => Error {
  return (e) =>
    new Error(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
}

// ---------------------------------------------------------------------------
// DockerService tag
// ---------------------------------------------------------------------------

export class DockerService extends Context.Tag("nas/DockerService")<
  DockerService,
  {
    readonly build: (
      contextDir: string,
      imageName: string,
      labels: Record<string, string>,
    ) => Effect.Effect<void, Error>;
    readonly runInteractive: (
      opts: DockerRunOpts,
    ) => Effect.Effect<void, Error>;
    readonly runDetached: (
      opts: DockerRunDetachedOpts,
    ) => Effect.Effect<string, Error>;
    readonly isRunning: (name: string) => Effect.Effect<boolean, Error>;
    readonly containerExists: (name: string) => Effect.Effect<boolean, Error>;
    readonly rm: (name: string) => Effect.Effect<void, Error>;
    readonly logs: (name: string) => Effect.Effect<string, Error>;
    readonly networkCreate: (
      name: string,
      opts: { internal?: boolean; labels?: Record<string, string> },
    ) => Effect.Effect<void, Error>;
    readonly networkConnect: (
      network: string,
      container: string,
      opts?: { aliases?: string[] },
    ) => Effect.Effect<void, Error>;
    readonly networkDisconnect: (
      network: string,
      container: string,
    ) => Effect.Effect<void, Error>;
    readonly networkRemove: (network: string) => Effect.Effect<void, Error>;
    readonly stop: (
      name: string,
      opts?: { timeoutSeconds?: number },
    ) => Effect.Effect<void, Error>;
    readonly exec: (
      container: string,
      cmd: string[],
      opts?: { user?: string },
    ) => Effect.Effect<string, Error>;
    readonly containerIp: (name: string) => Effect.Effect<string, Error>;
    readonly volumeCreate: (
      name: string,
      opts?: { labels?: Record<string, string> },
    ) => Effect.Effect<void, Error>;
    readonly volumeRemove: (name: string) => Effect.Effect<void, Error>;
    readonly inspect: (
      name: string,
    ) => Effect.Effect<DockerContainerDetails, Error>;
    readonly listContainerNames: () => Effect.Effect<string[], Error>;
    readonly listNetworkNames: () => Effect.Effect<string[], Error>;
    readonly inspectNetwork: (
      name: string,
    ) => Effect.Effect<DockerNetworkDetails, Error>;
    readonly listVolumeNames: () => Effect.Effect<string[], Error>;
    readonly inspectVolume: (
      name: string,
    ) => Effect.Effect<DockerVolumeDetails, Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const DockerServiceLive: Layer.Layer<DockerService> = Layer.succeed(
  DockerService,
  DockerService.of({
    build: (contextDir, imageName, labels) =>
      Effect.tryPromise({
        try: () => dockerBuild(contextDir, imageName, labels),
        catch: wrapError("docker build failed"),
      }),

    runInteractive: (opts) =>
      Effect.tryPromise({
        try: () =>
          dockerRun({
            image: opts.image,
            args: opts.args,
            envVars: opts.envVars,
            command: opts.command,
            interactive: true,
            name: opts.name,
            labels: opts.labels,
          }),
        catch: wrapError("docker run (interactive) failed"),
      }),

    runDetached: (opts) =>
      Effect.tryPromise({
        try: async () => {
          await dockerRunDetached(opts);
          return opts.name;
        },
        catch: wrapError("docker run (detached) failed"),
      }),

    isRunning: (name) =>
      Effect.tryPromise({
        try: () => dockerIsRunning(name),
        catch: wrapError("docker inspect failed"),
      }),

    containerExists: (name) =>
      Effect.tryPromise({
        try: () => dockerContainerExists(name),
        catch: wrapError("docker inspect failed"),
      }),

    rm: (name) =>
      Effect.tryPromise({
        try: () => dockerRm(name),
        catch: wrapError("docker rm failed"),
      }),

    logs: (name) =>
      Effect.tryPromise({
        try: () => dockerLogs(name),
        catch: wrapError("docker logs failed"),
      }),

    networkCreate: (name, opts) =>
      Effect.tryPromise({
        try: () => dockerNetworkCreateWithLabels(name, opts),
        catch: wrapError("docker network create failed"),
      }),

    networkConnect: (network, container, opts) =>
      Effect.tryPromise({
        try: () => dockerNetworkConnect(network, container, opts),
        catch: wrapError("docker network connect failed"),
      }),

    networkDisconnect: (network, container) =>
      Effect.tryPromise({
        try: () => dockerNetworkDisconnect(network, container),
        catch: wrapError("docker network disconnect failed"),
      }),

    networkRemove: (network) =>
      Effect.tryPromise({
        try: () => dockerNetworkRemove(network),
        catch: wrapError("docker network rm failed"),
      }),

    stop: (name, opts) =>
      Effect.tryPromise({
        try: () => dockerStop(name, opts),
        catch: wrapError("docker stop failed"),
      }),

    exec: (container, cmd, opts) =>
      Effect.tryPromise({
        try: async () => {
          const result = await dockerExec(container, cmd, opts);
          if (result.code !== 0) {
            throw new Error(`docker exec exited with code ${result.code}`);
          }
          return result.stdout;
        },
        catch: wrapError("docker exec failed"),
      }),

    containerIp: (name) =>
      Effect.tryPromise({
        try: async () => {
          const ip = await dockerContainerIp(name);
          if (ip === null) {
            throw new Error(`no IP address found for container ${name}`);
          }
          return ip;
        },
        catch: wrapError("docker inspect failed"),
      }),

    volumeCreate: (name, opts) =>
      Effect.tryPromise({
        try: () => dockerVolumeCreate(name, opts?.labels),
        catch: wrapError("docker volume create failed"),
      }),

    volumeRemove: (name) =>
      Effect.tryPromise({
        try: () => dockerVolumeRemove(name),
        catch: wrapError("docker volume rm failed"),
      }),

    inspect: (name) =>
      Effect.tryPromise({
        try: () => dockerInspectContainer(name),
        catch: wrapError("docker inspect failed"),
      }),

    listContainerNames: () =>
      Effect.tryPromise({
        try: () => dockerListContainerNames(),
        catch: wrapError("docker ps failed"),
      }),

    listNetworkNames: () =>
      Effect.tryPromise({
        try: () => dockerListNetworkNames(),
        catch: wrapError("docker network ls failed"),
      }),

    inspectNetwork: (name) =>
      Effect.tryPromise({
        try: () => dockerInspectNetwork(name),
        catch: wrapError("docker network inspect failed"),
      }),

    listVolumeNames: () =>
      Effect.tryPromise({
        try: () => dockerListVolumeNames(),
        catch: wrapError("docker volume ls failed"),
      }),

    inspectVolume: (name) =>
      Effect.tryPromise({
        try: () => dockerInspectVolume(name),
        catch: wrapError("docker volume inspect failed"),
      }),
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface DockerServiceFakeConfig {
  readonly build?: (
    contextDir: string,
    imageName: string,
    labels: Record<string, string>,
  ) => Effect.Effect<void, Error>;
  readonly runInteractive?: (opts: DockerRunOpts) => Effect.Effect<void, Error>;
  readonly runDetached?: (
    opts: DockerRunDetachedOpts,
  ) => Effect.Effect<string, Error>;
  readonly isRunning?: (name: string) => Effect.Effect<boolean, Error>;
  readonly containerExists?: (name: string) => Effect.Effect<boolean, Error>;
  readonly rm?: (name: string) => Effect.Effect<void, Error>;
  readonly logs?: (name: string) => Effect.Effect<string, Error>;
  readonly networkCreate?: (
    name: string,
    opts: { internal?: boolean; labels?: Record<string, string> },
  ) => Effect.Effect<void, Error>;
  readonly networkConnect?: (
    network: string,
    container: string,
    opts?: { aliases?: string[] },
  ) => Effect.Effect<void, Error>;
  readonly networkDisconnect?: (
    network: string,
    container: string,
  ) => Effect.Effect<void, Error>;
  readonly networkRemove?: (network: string) => Effect.Effect<void, Error>;
  readonly stop?: (
    name: string,
    opts?: { timeoutSeconds?: number },
  ) => Effect.Effect<void, Error>;
  readonly exec?: (
    container: string,
    cmd: string[],
    opts?: { user?: string },
  ) => Effect.Effect<string, Error>;
  readonly containerIp?: (name: string) => Effect.Effect<string, Error>;
  readonly volumeCreate?: (
    name: string,
    opts?: { labels?: Record<string, string> },
  ) => Effect.Effect<void, Error>;
  readonly volumeRemove?: (name: string) => Effect.Effect<void, Error>;
  readonly inspect?: (
    name: string,
  ) => Effect.Effect<DockerContainerDetails, Error>;
  readonly listContainerNames?: () => Effect.Effect<string[], Error>;
  readonly listNetworkNames?: () => Effect.Effect<string[], Error>;
  readonly inspectNetwork?: (
    name: string,
  ) => Effect.Effect<DockerNetworkDetails, Error>;
  readonly listVolumeNames?: () => Effect.Effect<string[], Error>;
  readonly inspectVolume?: (
    name: string,
  ) => Effect.Effect<DockerVolumeDetails, Error>;
}

export function makeDockerServiceFake(
  overrides: DockerServiceFakeConfig = {},
): Layer.Layer<DockerService> {
  return Layer.succeed(
    DockerService,
    DockerService.of({
      build: overrides.build ?? (() => Effect.void),
      runInteractive: overrides.runInteractive ?? (() => Effect.void),
      runDetached:
        overrides.runDetached ?? ((opts) => Effect.succeed(opts.name)),
      isRunning: overrides.isRunning ?? (() => Effect.succeed(false)),
      containerExists:
        overrides.containerExists ?? (() => Effect.succeed(false)),
      rm: overrides.rm ?? (() => Effect.void),
      logs: overrides.logs ?? (() => Effect.succeed("")),
      networkCreate: overrides.networkCreate ?? (() => Effect.void),
      networkConnect: overrides.networkConnect ?? (() => Effect.void),
      networkDisconnect: overrides.networkDisconnect ?? (() => Effect.void),
      networkRemove: overrides.networkRemove ?? (() => Effect.void),
      stop: overrides.stop ?? (() => Effect.void),
      exec: overrides.exec ?? (() => Effect.succeed("")),
      containerIp: overrides.containerIp ?? (() => Effect.succeed("")),
      volumeCreate: overrides.volumeCreate ?? (() => Effect.void),
      volumeRemove: overrides.volumeRemove ?? (() => Effect.void),
      inspect:
        overrides.inspect ??
        ((name) =>
          Effect.succeed({
            name,
            running: false,
            labels: {},
            networks: [],
            startedAt: "",
          })),
      listContainerNames:
        overrides.listContainerNames ?? (() => Effect.succeed([])),
      listNetworkNames:
        overrides.listNetworkNames ?? (() => Effect.succeed([])),
      inspectNetwork:
        overrides.inspectNetwork ??
        ((name) =>
          Effect.succeed({
            name,
            labels: {},
            containers: [],
          })),
      listVolumeNames: overrides.listVolumeNames ?? (() => Effect.succeed([])),
      inspectVolume:
        overrides.inspectVolume ??
        ((name) =>
          Effect.succeed({
            name,
            labels: {},
            containers: [],
          })),
    }),
  );
}
