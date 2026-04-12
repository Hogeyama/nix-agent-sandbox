---
name: effect-separation
description: Stage Architecture — Effect-based Design Rules. Use when adding new stages, modifying existing stages, creating helper functions, or refactoring pipeline code. Always consult when touching stages/, pipeline/, services/, or agents/ directories, or when design questions arise about where to place side-effects.
---

# Effect-based Stage Architecture

All pipeline stages use a single type: `EffectStage<R>`. Each stage declares its required services via the type parameter `R`, performs I/O exclusively through Effect services, and registers cleanup via Effect's `Scope`.

## EffectStage<R>

```typescript
export interface EffectStage<R extends StageServices = never> {
  kind: "effect";
  name: string;
  run(input: StageInput): Effect.Effect<EffectStageResult, unknown, Scope.Scope | R>;
}

export type AnyStage = EffectStage<StageServices>;
```

- `R` lists the services this stage requires (e.g. `FsService | DockerService`).
- `Scope.Scope` is always present for resource management but is not part of `R`.
- `EffectStageResult` is `Partial<PriorStageOutputs>` -- each stage returns only the fields it modifies.

## Service Inventory

### Generic Services (src/services/)

| Service | Purpose | Key methods |
|---|---|---|
| `FsService` | Filesystem operations | `mkdir`, `writeFile`, `readFile`, `chmod`, `symlink`, `rm`, `rename`, `stat`, `exists` |
| `ProcessService` | Spawn and exec processes | `spawn`, `exec`, `waitForFileExists` |
| `DockerService` | Docker CLI operations | `build`, `runInteractive`, `runDetached`, `isRunning`, `stop`, `exec`, `logs`, `containerIp`, `volumeCreate`, `networkCreate`, ... |
| `PromptService` | Interactive user prompts | `worktreeAction`, `dirtyWorktreeAction`, `branchAction`, `reuseWorktree`, `renameBranchPrompt` |

### Domain Services (src/services/)

| Service | Purpose |
|---|---|
| `DindService` | Docker-in-Docker sidecar lifecycle (`ensureSidecar` / `teardownSidecar`) |
| `SessionBrokerService` | Network session broker lifecycle (`start` -> handle with `close`) |
| `HostExecBrokerService` | Host-exec broker lifecycle (`start` -> handle with `close`) |
| `AuthRouterService` | Envoy auth router daemon lifecycle (`ensureDaemon` -> handle with `abort`) |
| `SessionStoreService` | Session record persistence (`ensurePaths`, `create`, `delete`) |

Each service file exports three things:
- **Tag**: `FsService` (the `Context.Tag`)
- **Live layer**: `FsServiceLive` (real implementation)
- **Fake factory**: `makeFsServiceFake()` (for testing)

## Writing a New Stage

### 1. Define a stage-local plan type (optional)

If the stage has a pure planning step, define a plan type specific to that stage:

```typescript
interface MyPlan {
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly directories: string[];
}

function planMyStage(input: StageInput): MyPlan | null {
  // Pure function -- no I/O allowed
}
```

### 2. Create the stage factory

```typescript
export function createMyStage(): EffectStage<FsService | DockerService> {
  return {
    kind: "effect",
    name: "MyStage",
    run(input) {
      return Effect.gen(function* () {
        const plan = planMyStage(input);
        if (!plan) return {};

        const fs = yield* FsService;
        const docker = yield* DockerService;

        // Execute I/O through services
        for (const dir of plan.directories) {
          yield* fs.mkdir(dir, { recursive: true });
        }

        yield* docker.build(contextDir, imageName, {});

        return {
          dockerArgs: [...(input.prior.dockerArgs ?? []), ...plan.dockerArgs],
          envVars: { ...input.prior.envVars, ...plan.envVars },
        };
      });
    },
  };
}
```

### 3. Register cleanup with Scope

Use `acquireRelease` or `addFinalizer` for resources that need teardown:

```typescript
// acquireRelease pattern -- acquire and release are paired
yield* Effect.acquireRelease(
  brokerService.start(socketPath, config),
  (handle) => handle.close().pipe(
    Effect.catchAll(() => Effect.logWarning("broker close failed")),
  ),
);

// addFinalizer pattern -- register cleanup for something already acquired
yield* fs.mkdir(tmpDir, { recursive: true });
yield* Effect.addFinalizer(() =>
  fs.rm(tmpDir, { recursive: true, force: true }).pipe(
    Effect.catchAll(() => Effect.logWarning("cleanup failed")),
  ),
);
```

Finalizer rules:
- Register cleanup immediately after acquiring the resource. Do not place fallible operations between acquire and finalizer registration.
- Finalizers must never fail. Wrap with `Effect.catchAll(() => Effect.logWarning(...))`.

## Pipeline Execution

### runPipeline

```typescript
function runPipeline<const TStages extends readonly AnyStage[]>(
  stages: TStages,
  input: StageInput,
): Effect.Effect<PriorStageOutputs, unknown, PipelineRequirements<TStages>>
```

Runs stages sequentially. Each stage receives cumulative `prior` outputs from all preceding stages. The return type `PipelineRequirements<TStages>` is the union of all stages' `R` plus `Scope.Scope`.

### cli.ts (entry point)

```typescript
const exit = await Effect.runPromiseExit(
  runPipeline(stages, input).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(
      FsServiceLive,
      ProcessServiceLive,
      DockerServiceLive,
      PromptServiceLive,
      DindServiceLive,
      SessionBrokerServiceLive,
      HostExecBrokerServiceLive,
      AuthRouterServiceLive,
      SessionStoreServiceLive,
    )),
  ),
);
```

`Effect.scoped` creates a single `Scope` for the entire pipeline. All finalizers registered by stages run when the scope closes (in reverse order).

## Testing

### Pure planner tests

Call the plan function directly. No Effect runtime needed:

```typescript
const plan = planMount(input);
expect(plan.dockerArgs).toContainEqual("-v");
```

### Stage tests with fake services

Provide fake layers and run the stage in a scoped Effect:

```typescript
const fakeFs = makeFsServiceFake();
const fakeDocker = makeDockerServiceFake();

const result = await Effect.runPromise(
  Effect.scoped(
    stage.run(input).pipe(
      Effect.provide(Layer.mergeAll(
        fakeFs.layer,
        fakeDocker.layer,
      )),
    ),
  ),
);

expect(fakeFs.calls.mkdir).toEqual([...]);
expect(result.dockerArgs).toContain("--network");
```

Fake factories return a layer plus a spy object to verify which service methods were called and with what arguments.

## File Layout

```
src/
  services/
    fs.ts                    # FsService Tag, Live, Fake
    process.ts               # ProcessService Tag, Live, Fake
    docker.ts                # DockerService Tag, Live, Fake
    dind.ts                  # DindService Tag, Live, Fake
    session_broker.ts        # SessionBrokerService Tag, Live, Fake
    hostexec_broker.ts       # HostExecBrokerService Tag, Live, Fake
    auth_router.ts           # AuthRouterService Tag, Live, Fake
    session_store_service.ts # SessionStoreService Tag, Live, Fake
  stages/
    nix_detect.ts            # EffectStage<never>
    mount.ts                 # EffectStage<FsService>
    docker_build.ts          # EffectStage<FsService | DockerService>
    launch.ts                # EffectStage<DockerService>
    dbus_proxy.ts            # EffectStage<FsService | ProcessService>
    dind.ts                  # EffectStage<DindService>
    proxy.ts                 # EffectStage<FsService | DockerService | SessionBrokerService | AuthRouterService>
    hostexec.ts              # EffectStage<FsService | HostExecBrokerService>
    session_store.ts         # EffectStage<SessionStoreService>
    worktree.ts              # EffectStage<PromptService | FsService | ProcessService>
    worktree/
      prompt_service.ts      # PromptService Tag, Live, Fake
  pipeline/
    types.ts                 # EffectStage<R>, StageServices, PipelineRequirements, StageInput, etc.
    pipeline.ts              # runPipeline
```

## Naming Conventions

| Prefix | Meaning | Side-effects |
|---|---|---|
| `build*`, `format*`, `expand*`, `parse*`, `merge*`, `validate*` | Pure computation | Forbidden |
| `plan*` | Pure stage planner | Forbidden |
| `resolve*` | I/O-based resolution (probes) | Allowed |
| `ensure*` | Create if missing | Allowed (via service) |
| `make*Fake` | Test fake factory | N/A |

## Module-Level Constraints

- Module-level `const`: true constants only (literals, regexes, etc.).
- Module-level `let`: forbidden.
- Module-level side-effects (file reads, env access): forbidden.

## Design Decision Flowchart

1. **Need a stage?** -- Create an `EffectStage<R>` with appropriate service requirements.
2. **Has a pure planning step?** -- Extract a `planXxx()` function returning a stage-local plan type. Call it from `run()`.
3. **Needs I/O?** -- Use a service. Never call `node:fs`, `Bun.spawn`, or Docker CLI functions directly from `run()`.
4. **Needs resource cleanup?** -- Use `Effect.acquireRelease` or `Effect.addFinalizer` within `run()`. Never manage teardown arrays manually.
5. **Adding a new service?** -- Define Tag + Live + Fake in `src/services/`. Add the service to the `StageServices` union in `types.ts`.
6. **Adding/modifying an agent?** -- I/O goes in `resolve*Probes()`, pure logic in `configure*()`.
