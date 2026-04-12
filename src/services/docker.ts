/**
 * DockerService — Effect-based abstraction over Docker CLI operations.
 *
 * Live implementation delegates to existing functions in src/docker/client.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import {
  dockerBuild,
  dockerContainerExists,
  dockerContainerIp,
  dockerExec,
  dockerIsRunning,
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
// DockerService tag
// ---------------------------------------------------------------------------

export class DockerService extends Context.Tag("nas/DockerService")<
  DockerService,
  {
    readonly build: (
      contextDir: string,
      imageName: string,
      labels: Record<string, string>,
    ) => Effect.Effect<void>;
    readonly runInteractive: (opts: DockerRunOpts) => Effect.Effect<void>;
    readonly runDetached: (
      opts: DockerRunDetachedOpts,
    ) => Effect.Effect<string>;
    readonly isRunning: (name: string) => Effect.Effect<boolean>;
    readonly containerExists: (name: string) => Effect.Effect<boolean>;
    readonly rm: (name: string) => Effect.Effect<void>;
    readonly logs: (name: string) => Effect.Effect<string>;
    readonly networkCreate: (
      name: string,
      opts: { internal?: boolean; labels?: Record<string, string> },
    ) => Effect.Effect<void>;
    readonly networkConnect: (
      network: string,
      container: string,
      opts?: { aliases?: string[] },
    ) => Effect.Effect<void>;
    readonly networkDisconnect: (
      network: string,
      container: string,
    ) => Effect.Effect<void>;
    readonly networkRemove: (network: string) => Effect.Effect<void>;
    readonly stop: (
      name: string,
      opts?: { timeoutSeconds?: number },
    ) => Effect.Effect<void>;
    readonly exec: (
      container: string,
      cmd: string[],
      opts?: { user?: string },
    ) => Effect.Effect<string>;
    readonly containerIp: (name: string) => Effect.Effect<string>;
    readonly volumeCreate: (
      name: string,
      opts?: { labels?: Record<string, string> },
    ) => Effect.Effect<void>;
    readonly volumeRemove: (name: string) => Effect.Effect<void>;
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
        catch: (e) =>
          new Error(
            `docker build failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

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
        catch: (e) =>
          new Error(
            `docker run (interactive) failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    runDetached: (opts) =>
      Effect.tryPromise({
        try: async () => {
          await dockerRunDetached(opts);
          return opts.name;
        },
        catch: (e) =>
          new Error(
            `docker run (detached) failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    isRunning: (name) =>
      Effect.tryPromise({
        try: () => dockerIsRunning(name),
        catch: (e) =>
          new Error(
            `docker inspect failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    containerExists: (name) =>
      Effect.tryPromise({
        try: () => dockerContainerExists(name),
        catch: (e) =>
          new Error(
            `docker inspect failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    rm: (name) =>
      Effect.tryPromise({
        try: () => dockerRm(name),
        catch: (e) =>
          new Error(
            `docker rm failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    logs: (name) =>
      Effect.tryPromise({
        try: () => dockerLogs(name),
        catch: (e) =>
          new Error(
            `docker logs failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    networkCreate: (name, opts) =>
      Effect.tryPromise({
        try: () => dockerNetworkCreateWithLabels(name, opts),
        catch: (e) =>
          new Error(
            `docker network create failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    networkConnect: (network, container, opts) =>
      Effect.tryPromise({
        try: () => dockerNetworkConnect(network, container, opts),
        catch: (e) =>
          new Error(
            `docker network connect failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    networkDisconnect: (network, container) =>
      Effect.tryPromise({
        try: () => dockerNetworkDisconnect(network, container),
        catch: (e) =>
          new Error(
            `docker network disconnect failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    networkRemove: (network) =>
      Effect.tryPromise({
        try: () => dockerNetworkRemove(network),
        catch: (e) =>
          new Error(
            `docker network rm failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    stop: (name, opts) =>
      Effect.tryPromise({
        try: () => dockerStop(name, opts),
        catch: (e) =>
          new Error(
            `docker stop failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    exec: (container, cmd, opts) =>
      Effect.tryPromise({
        try: async () => {
          const result = await dockerExec(container, cmd, opts);
          if (result.code !== 0) {
            throw new Error(`docker exec exited with code ${result.code}`);
          }
          return result.stdout;
        },
        catch: (e) =>
          new Error(
            `docker exec failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    containerIp: (name) =>
      Effect.tryPromise({
        try: async () => {
          const ip = await dockerContainerIp(name);
          if (ip === null) {
            throw new Error(`no IP address found for container ${name}`);
          }
          return ip;
        },
        catch: (e) =>
          new Error(
            `docker inspect failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    volumeCreate: (name, opts) =>
      Effect.tryPromise({
        try: () => dockerVolumeCreate(name, opts?.labels),
        catch: (e) =>
          new Error(
            `docker volume create failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),

    volumeRemove: (name) =>
      Effect.tryPromise({
        try: () => dockerVolumeRemove(name),
        catch: (e) =>
          new Error(
            `docker volume rm failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),
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
  ) => Effect.Effect<void>;
  readonly runInteractive?: (opts: DockerRunOpts) => Effect.Effect<void>;
  readonly runDetached?: (opts: DockerRunDetachedOpts) => Effect.Effect<string>;
  readonly isRunning?: (name: string) => Effect.Effect<boolean>;
  readonly containerExists?: (name: string) => Effect.Effect<boolean>;
  readonly rm?: (name: string) => Effect.Effect<void>;
  readonly logs?: (name: string) => Effect.Effect<string>;
  readonly networkCreate?: (
    name: string,
    opts: { internal?: boolean; labels?: Record<string, string> },
  ) => Effect.Effect<void>;
  readonly networkConnect?: (
    network: string,
    container: string,
    opts?: { aliases?: string[] },
  ) => Effect.Effect<void>;
  readonly networkDisconnect?: (
    network: string,
    container: string,
  ) => Effect.Effect<void>;
  readonly networkRemove?: (network: string) => Effect.Effect<void>;
  readonly stop?: (
    name: string,
    opts?: { timeoutSeconds?: number },
  ) => Effect.Effect<void>;
  readonly exec?: (
    container: string,
    cmd: string[],
    opts?: { user?: string },
  ) => Effect.Effect<string>;
  readonly containerIp?: (name: string) => Effect.Effect<string>;
  readonly volumeCreate?: (
    name: string,
    opts?: { labels?: Record<string, string> },
  ) => Effect.Effect<void>;
  readonly volumeRemove?: (name: string) => Effect.Effect<void>;
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
    }),
  );
}
