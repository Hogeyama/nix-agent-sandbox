/**
 * ContainerLaunchService — Effect-based abstraction over container launch.
 *
 * Encapsulates the DockerService.runInteractive call so that stages
 * depend on this higher-level service instead of the primitive DockerService.
 *
 * Live implementation delegates to DockerService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import { type DockerRunOpts, DockerService } from "../../services/docker.ts";

// ---------------------------------------------------------------------------
// Service-local option type (re-exports DockerRunOpts since it is a
// service-level type and service → service dependency is allowed)
// ---------------------------------------------------------------------------

export type LaunchOpts = DockerRunOpts;

// ---------------------------------------------------------------------------
// ContainerLaunchService tag
// ---------------------------------------------------------------------------

export class ContainerLaunchService extends Context.Tag(
  "nas/ContainerLaunchService",
)<
  ContainerLaunchService,
  {
    readonly launch: (opts: LaunchOpts) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const ContainerLaunchServiceLive: Layer.Layer<
  ContainerLaunchService,
  never,
  DockerService
> = Layer.effect(
  ContainerLaunchService,
  Effect.gen(function* () {
    const docker = yield* DockerService;

    return ContainerLaunchService.of({
      launch: (opts) => {
        const run = docker.runInteractive(opts).pipe(Effect.orDie);
        // ACP の起動は中断されると docker run を止めて container を消す。
        // 端末に attach した docker run は promise を捨てても止まらないので、
        // 中断されても docker run が終わるまで待ってから Scope を閉じる。
        // セッションを中断する側は、先に container を止める。
        return opts.mode === "acp" ? run : Effect.uninterruptible(run);
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface ContainerLaunchServiceFakeConfig {
  readonly launch?: (opts: LaunchOpts) => Effect.Effect<void>;
}

export function makeContainerLaunchServiceFake(
  overrides: ContainerLaunchServiceFakeConfig = {},
): Layer.Layer<ContainerLaunchService> {
  return Layer.succeed(
    ContainerLaunchService,
    ContainerLaunchService.of({
      launch: overrides.launch ?? (() => Effect.void),
    }),
  );
}
