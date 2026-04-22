---
name: effect-separation
description: Effect-based service architecture for this codebase — covers pipeline stages (src/stages/, src/services/) and long-lived domain services shared between CLI and UI (src/domain/). Use when adding or modifying stages, creating helper functions, refactoring pipeline code, adding or touching services under src/domain/, or consolidating primitive-direct-call duplication in src/cli/, src/ui/data.ts, or src/ui/routes/. Always consult when touching stages/, pipeline/, services/, domain/, or agents/ directories, or when design questions arise about where to place side-effects.
---

# Effect-based Stage Architecture

> **Non-negotiable:** A stage is an orchestration boundary, not an I/O implementation site.
> - Never call `node:fs`, `node:child_process`, `Bun.spawn`, Docker CLI helpers, socket APIs, or ad-hoc cleanup code from a stage.
> - Do not script low-level setup or teardown in `run()`, even if the calls happen to go through `FsService`, `ProcessService`, or `DockerService`.
> - `run()` may only do three things: call pure planners, call stage-facing service methods, and return `EffectStageResult`.
> - `FsService.readFile()` or `docker.inspect()` do not get a special exemption just because they are single calls. Put primitive I/O in probes or services, not in the stage.
> - If you feel tempted to write `mkdir`, `writeFile`, `spawn`, `exec`, `rm`, `networkCreate`, or similar steps in a stage, stop and extract a service first.

All pipeline stages use a single type: `EffectStage<R>`. A stage declares its required services via `R`, computes pure data when helpful, and orchestrates service calls inside a shared `Scope`.

## Service Tiers

nas organizes service-level code into four tiers by reusability and call context:

| tier | role | location | called from | examples |
|---|---|---|---|---|
| L1 | primitive | `src/services/` | Effect only | `FsService`, `DockerService`, `ProcessService` |
| L2 | domain (nas-specific, reusable) | `src/domain/<name>/service.ts` | **plain-async or Effect** | `ContainerQueryService`, `SessionUiService`, `AuditQueryService` |
| L3-a | stage-only | `src/stages/<name>/*_service.ts` | Effect only (stage `run()`) | `DindService`, `GitWorktreeService` |
| L3-b | api-only (rare) | `src/ui/routes/<name>_service.ts` | plain-async (HTTP route) | none yet — `sse_diff.ts` stays a pure function |

Call-direction rules:
- L3-a and L3-b may call L1 and L2.
- L3-a and L3-b never call each other — sibling tiers.
- L2 may call L2; declare the dependency in `R` honestly and close it at the `makeXxxClient` adapter.
- Reverse flow (L1→L2, L2→L3) is forbidden.

**This document covers the L1 primitive and L3-a stage service rules.**
For L2 domain services (long-lived CRUD shared between CLI and UI),
read `references/domain-service.md`. They reuse the same Tag + Live +
Fake idiom but add a plain-async client bridge, a different R-closure
strategy, and typed-error unwrap at the adapter boundary.

## EffectStage<R>

```typescript
export interface EffectStage<R extends StageServices = never> {
  kind: "effect";
  name: string;
  run(input: StageInput): Effect.Effect<EffectStageResult, unknown, Scope.Scope | R>;
}

export type AnyStage = EffectStage<StageServices>;
```

- `R` lists the services this stage requires.
- Prefer stage-facing services in `R`. Primitive services should usually stay behind probes or domain services.
- `Scope.Scope` is always present for resource management but is not part of `R`.
- `EffectStageResult` is `Partial<PriorStageOutputs>` -- each stage returns only the fields it modifies.

## Directory Layout & Naming

**`src/services/` holds only cross-cutting primitives.** Stage-specific services live inside their owning stage's subdirectory.

```
src/services/                 # 3 primitives only (fs, process, docker)
src/stages/<name>.ts          # barrel re-export (public API)
src/stages/<name>/
├── stage.ts                  # stage orchestrator (createXxxStage, planXxx)
├── stage_test.ts
├── *_service.ts              # Effect service(s): Tag + Live + Fake
├── *_service_test.ts
├── *_probes.ts               # pre-stage IO resolver (plain async, returns data)
└── <helper>.ts               # helpers / domain types (no suffix)
```

### File suffix convention

The suffix marks the **Effect boundary** and **execution phase**:

| Suffix | Role | Effect framework | When it runs |
|---|---|---|---|
| `_service.ts` | Effect Service (Tag + Live + Fake Layer) | inside | during `run()` |
| `_probes.ts` | Plain async IO resolver → data | outside | before any stage (pre-pipeline) |
| (no suffix) | Pure helper / domain type / utility | n/a | n/a |
| `stage.ts` | Orchestrator | inside (`Effect.gen`) | during `run()` |

Importantly, **probes are not services**. A probe returns plain data (`Promise<MountProbes>`), runs once at pipeline startup, and is passed into the stage as an argument. Tests fabricate the data directly — no Fake Layer needed. A service runs lazily inside `run()` via a Context.Tag and is fake-able through Layer substitution.

### Barrel re-exports

`src/stages/<name>.ts` re-exports the stage factory and the service Tag/Live/Fake triad. External consumers (`cli.ts`, `pipeline/types.ts`, cross-stage imports) import from the barrel, not from the subdirectory's inner files. Internal tests and siblings inside the subdirectory import directly.

### Where to put a new service

- Shared by many stages and truly cross-cutting (like `FsService`, `ProcessService`, `DockerService`) → `src/services/`.
- Scoped to one stage's concern → `src/stages/<owning-stage>/<name>_service.ts`, and re-export from the barrel. Default to this location unless you can point at concrete cross-stage consumers.

## Service Inventory

### Cross-cutting primitives (`src/services/`, usually not stage-facing)

Thin adapters over OS or Docker primitives. Treat these as implementation details of probes and domain services, not as the normal interface of stage code.

| Service | Purpose | Key methods |
|---|---|---|
| `FsService` | Filesystem primitives | `mkdir`, `writeFile`, `readFile`, `chmod`, `symlink`, `rm`, `rename`, `stat`, `exists` |
| `ProcessService` | Process primitives | `spawn`, `exec`, `waitForFileExists` |
| `DockerService` | Docker CLI primitives | `build`, `runInteractive`, `runDetached`, `isRunning`, `stop`, `exec`, `logs`, `containerIp`, `volumeCreate`, `networkCreate`, ... |

If a stage needs a file read, process exec, or Docker query, the default answer is still "move that primitive behind a probe or a domain service." Do not create stage-level exceptions just because the I/O sequence is short.

### Stage-facing interaction services

Generic interaction, but the interaction itself is often the stage behavior, so direct stage use is acceptable.

| Service | Location | Purpose | Key methods |
|---|---|---|---|
| `PromptService` | `src/stages/worktree/prompt_service.ts` | Interactive prompts | `worktreeAction`, `dirtyWorktreeAction`, `branchAction`, `reuseWorktree`, `renameBranchPrompt` |

### Stage-owned domain services

Preferred stage-facing boundaries for named workflows and lifecycles. All live inside their owning stage's subdirectory.

| Service | Stage | Purpose |
|---|---|---|
| `DindService` | `stages/dind/dind_service.ts` | Docker-in-Docker sidecar lifecycle (`ensureSidecar` / `teardownSidecar`) |
| `SessionBrokerService` | `stages/proxy/session_broker_service.ts` | Network session broker lifecycle (`start` -> handle with `close`) |
| `HostExecBrokerService` | `stages/hostexec/broker_service.ts` | Host-exec broker lifecycle (`start` -> handle with `close`) |
| `AuthRouterService` | `stages/proxy/auth_router_service.ts` | Envoy auth router daemon lifecycle (`ensureDaemon` -> handle with `abort`) |
| `SessionStoreService` | `stages/session_store/session_store_service.ts` | Session record persistence (`ensurePaths`, `create`, `delete`) |
| `GitWorktreeService` | `stages/worktree/git_worktree_service.ts` | Git worktree lifecycle (D1/D2 layered: see file-private `*Ops` tags) |

Each service file exports three things:

- **Tag**: `FsService` (the `Context.Tag`)
- **Live layer**: `FsServiceLive` (real implementation)
- **Fake factory**: `makeFsServiceFake()` (for testing)

Fake factories are not all identical: some return only a layer, others return a layer plus test state. Follow the existing pattern of the service you are touching.

### When to introduce a domain service

Create or reuse a domain service when any of these are true:

- One conceptual action would otherwise require multiple low-level I/O steps.
- Resource ownership and cleanup must stay paired.
- The logic should be reusable across stages or easy to fake in tests.
- The operation needs invariants, retries, idempotency, or structured teardown.
- Your plan starts talking about directories, files, commands, temp paths, or teardown steps instead of a named capability.
- The stage would otherwise need a primitive service such as `FsService`, `ProcessService`, or `DockerService`.

If the work is only pure data shaping, keep it as a pure function instead of inventing a service.

### Composition rule inside services

The stage-level rule ("do not mix primitives with orchestration") applies recursively **inside** the service layer. Functions that build new effects by composing other effects must not simultaneously call IO primitives. Otherwise the composed logic cannot be unit-tested with fakes.

#### Two kinds of effect-producing functions

| # | Kind | Definition | Expected coverage |
|---|------|------------|-------------------|
| D1 | **Primitive effect wrapper** | Directly invokes an IO primitive (`proc.exec`, `proc.spawn`, `fs.*`, `docker.*`, raw `Bun.spawn`, socket APIs, etc.) and does not compose other effects. One function ~= one IO call. | Not unit-tested. Exercised by integration tests only. |
| D2 | **Composed effect** | Builds a new effect by sequencing / branching over other effect-returning functions. **Must not call IO primitives directly.** | Unit-tested with fakes. Target 80%+ line coverage, including branches. |

The same file can expose both kinds, but a single function must pick one role. Mixing them is the violation pattern this rule forbids.

#### Non-negotiable rules

- A D2 function may call other D1 / D2 functions, but **must not** call `proc.exec`, `proc.spawn`, `fs.readFile`, `fs.writeFile`, `fs.rm`, `docker.*`, `Bun.spawn`, `node:fs`, socket APIs, or other IO primitives inline.
- If a D2 function needs IO that has no existing wrapper, add a D1 wrapper (or a new domain-service method) first, then call that wrapper from D2.
- `gitExec`, `runCommand`, and similar helpers that shell out to external processes count as primitives for this rule. Wrapping an IO primitive in a thin helper does not make it non-primitive.
- D2 functions must be fake-able: every effect they invoke must be reachable through a service Tag or an injected dependency, so tests can substitute a Fake implementation.
- When a D2 function grows conditional branches (stash / cherry-pick / pop, retry, dirty-check), those branches are the primary motivation for this rule -- they are unreachable from integration tests and must be covered by unit tests.

#### Violation example

`services/git_worktree.ts` `cherryPickInWorktree` composes `checkDirty` (another effect) with five direct `gitExec` calls (primitive) in the same function body. That makes the stash / cherry-pick / abort / pop branching impossible to unit-test with a fake `checkDirty`, and forces every branch to be exercised through a real git process.

The fix is to split the function so that each branch of the composition calls an intentful D1/D2 helper (`stashChanges`, `applyCherryPick`, `abortCherryPick`, `popStash`), and the composed function only orchestrates.

#### Checklist when writing or reviewing a service function

1. Does this function call an IO primitive? -> It is D1. Keep it short and do not branch over other effects inside it.
2. Does this function compose other effects (sequence, branch, loop)? -> It is D2. Remove any inline primitive calls; extract them into D1 helpers.
3. Can you write a unit test that provides a Fake for every effect this function invokes, without spinning up a real process / filesystem / docker daemon? If no, the function is still mixing roles.
4. If the function grew conditional branches, are all branches reachable from unit tests with fakes? If not, the branches are effectively untested.

Stage code continues to follow the stricter rule from the top of this document: stages orchestrate intentful service methods and do not compose primitives at all.

#### Pattern: file-private Ops tags for layered D1/D2 services

When a single domain service has enough D2 functions that each want independent fakes — e.g. `createWorktree` composes `executeTeardown` composes `cherryPickToBase` composes `cherryPickInWorktree` — introduce one `Context.Tag` per D2 function to hold its D1 dependencies. `GitWorktreeService` (`src/stages/worktree/git_worktree_service.ts`) is the canonical example.

**Shape:**

1. **One Ops Tag per D2 function.** Export each Tag and each D2 function as `@internal Exported only for the colocated test file`. External callers see only the public service Tag.
2. **Live factory forwards to primitives, nothing else.** `makeXxxOpsLayer(proc, fs)` returns a `Layer.succeed(XxxOps, { ... })` where every method is a D1 wrapper — a single `proc.exec` / `fs.*` / `gitExec` call. **Never provide another Ops layer from inside a Live factory**; that hides transitive deps and breaks fake granularity.
3. **D2 R lists every transitive Ops, not just its immediate one.** If `executeTeardown` composes `cherryPickToBase`, its R is `TeardownOps | CherryPickToBaseOps | CherryPickOps`, not just `TeardownOps`. The type is the dependency manifest.
4. **Service boundary provides the whole stack with `Layer.mergeAll`.** The public service's Live impl (`GitWorktreeServiceLive.createWorktree`) is the single `Effect.provide(Layer.mergeAll(makeA(...), makeB(...), ...))` site. Tests skip this boundary and call D2 functions directly with their own fakes.
5. **Long-lived handles snapshot context to keep `R = never`.** When a D2 function returns a handle whose methods run later (e.g. `WorktreeHandle.close`), snapshot the teardown Ops at acquisition time:
   ```typescript
   const teardownCtx = yield* Effect.context<TeardownOps | CherryPickToBaseOps | CherryPickOps>();
   const handle = {
     close: (plan) => executeTeardown(handle, plan).pipe(Effect.provide(teardownCtx)),
   };
   ```
   The handle's external type stays `R = never` while the D2 function's R still truthfully advertises every Ops it transitively needs.

**Anti-patterns this rule forbids:**

- **Nested-provide Live factories.** A `TeardownOps.cherryPickToBase` method whose Live implementation internally `.pipe(Effect.provide(makeCherryPickToBaseOpsLayer(proc)))`. This makes `executeTeardown`'s R look like it only needs `TeardownOps`, but the real dependency graph is hidden, and tests can only fake the whole wrapper instead of the underlying D1s.
- **Callback-factory Ops methods.** An Ops method returning `(handle) => (plan) => Effect<void>` instead of `Effect<void>`. It has a different shape than every other Ops method and forces tests to fake the closure wholesale. Instead, make the Ops method return an Effect and let the D2 function do the composition.
- **Shrinking D2 R to the "immediate" Ops.** If you're tempted to wrap a sub-D2 in a single Ops method just to shorten the R, you're re-introducing the nested-provide anti-pattern. Hoist the transitive Ops into R instead.

**Tradeoff:** D2 signatures get longer as the Ops union grows. Accept it — the type *is* the dependency manifest, and fake-ability at Ops-method granularity is worth more than a compact signature.

**Status:** This pattern is still being explored. If you find a cleaner alternative while working in this area, flag it and we can revise — don't silently diverge.

## Writing a New Stage

### 1. Add a pure planner only when the plan itself deserves tests

A "stage-local plan type" is just the typed return value of `planXxx()`: a pure data object computed from `StageInput` and later handed to services. Introduce it only when that pure decision-making has enough branching or invariants to deserve focused unit tests. If `run()` is already trivial, or the pure logic is obvious, keep it inline or extract smaller pure helpers instead of introducing `planXxx()`.

```typescript
interface MyPlan {
  readonly workspace: {
    readonly sessionId: string;
    readonly runtimeDir: string;
  };
  readonly envVars: Record<string, string>;
  readonly outputOverrides: EffectStageResult;
}

function planMyStage(input: StageInput): MyPlan | null {
  // Pure computation only -- no I/O allowed
}
```

- Good plan fields describe intent (`workspace`, `outputOverrides`).
- If you would not write focused tests against `planXxx()`, you probably do not need `planXxx()`.
- If the plan starts listing `directories`, `files`, `commands`, or teardown work, that is usually a sign a service boundary is missing.

### 2. Put I/O behind a service before writing `run()`

If executing the plan would require filesystem, process, network, or Docker steps, create or reuse a service first. The stage should talk in named capabilities such as `prepareWorkspace`, `ensureDaemon`, `start`, or `syncState`, not in primitives such as `mkdir`, `readFile`, `writeFile`, `spawn`, `exec`, or `rm`.

```typescript
// Bad: low-level workflow in the stage
// yield* fs.mkdir(...);
// yield* fs.writeFile(...);
// yield* proc.spawn(...);

// Good: one intentful service call
yield* workspaceService.prepareWorkspace(plan.workspace);
```

### 3. Create the stage factory

```typescript
export function createMyStage(): EffectStage<MyStageService> {
  return {
    kind: "effect",
    name: "MyStage",
    run(input) {
      const plan = planMyStage(input);
      if (!plan) return Effect.succeed({});

      return Effect.gen(function* () {
        const myStageService = yield* MyStageService;

        yield* Effect.acquireRelease(
          myStageService.prepareWorkspace(plan.workspace),
          (handle) => handle.close().pipe(
            Effect.catchAll(() => Effect.logWarning("MyStage cleanup failed")),
          ),
        );

        return {
          envVars: { ...input.prior.envVars, ...plan.envVars },
          ...plan.outputOverrides,
        } satisfies EffectStageResult;
      });
    },
  };
}
```

The stage composes pure planning, service calls, and output merging. It does not describe low-level I/O steps itself.

### 4. Use Scope only for service-owned lifecycles

`Scope` in stage code is for pairing cleanup with a handle returned by a service. It is **not** permission to create temp directories, files, networks, or daemons directly in the stage and then delete them manually.

Prefer `Effect.acquireRelease` when the acquire/release pair is local:

```typescript
yield* Effect.acquireRelease(
  authRouterService.ensureDaemon(runtimePaths),
  (handle) => handle.abort().pipe(
    Effect.catchAll(() => Effect.logWarning("auth-router cleanup failed")),
  ),
);
```

Use `Effect.addFinalizer` only when you already have a handle from a service call:

```typescript
const handle = yield* sessionBrokerService.start(config);
yield* Effect.addFinalizer(() =>
  handle.close().pipe(
    Effect.catchAll(() => Effect.logWarning("session broker cleanup failed")),
  ),
);
```

Finalizer rules:
- Prefer `Effect.acquireRelease`; use `Effect.addFinalizer` only for an already-acquired service handle.
- Register cleanup immediately after acquisition. Do not place fallible operations between acquire and finalizer registration.
- Finalizers must never fail. Wrap them with `Effect.catchAll(() => Effect.logWarning(...))`.
- If the cleanup body would need `fs.rm`, `docker.stop`, `proc.exec`, or similar low-level operations, that cleanup belongs in a service, not the stage.

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

`Effect.scoped` creates a single `Scope` for the entire pipeline. All finalizers registered by stages and services run when the scope closes (in reverse order).

## Testing

### Pure planner tests

Only add these when you intentionally extracted `planXxx()` because the pure branching is worth testing directly. No Effect runtime needed:

```typescript
const plan = planMount(input, probes);
expect(plan?.envVars.NAS_USER).toBe("nas");
```

### Stage tests with fake services

Provide fake layers for the services the stage orchestrates and run the stage in a scoped Effect:

```typescript
const calls: Array<{ sessionId: string; runtimeDir: string }> = [];

const fakeMyStageService = Layer.succeed(
  MyStageService,
  MyStageService.of({
    prepareWorkspace: (workspace) =>
      Effect.sync(() => {
        calls.push(workspace);
        return { close: () => Effect.void };
      }),
  }),
);

const result = await Effect.runPromise(
  Effect.scoped(
    stage.run(input).pipe(
      Effect.provide(fakeMyStageService),
    ),
  ),
);

expect(calls).toEqual([{ sessionId: input.sessionId, runtimeDir: "/tmp/nas" }]);
expect(result.envVars.NAS_SESSION_ID).toBe(input.sessionId);
```

## Agents use the same split

Agent modules are not stages, but they follow the same separation rule.

- `resolve*Probes()` is the side-effectful boundary that inspects the host environment.
- `configure*()` is pure. It translates probes plus inputs into `dockerArgs`, `envVars`, and `agentCommand`.
- Stages such as `mount.ts` should call the pure `configure*()` functions, not re-run host inspection inline.
- If agent-specific behavior grows from "derive config" into a lifecycle or multi-step setup/teardown workflow, move that I/O behind a service instead of teaching `configure*()` to do effects.

## Module-Level Constraints

- Module-level `const`: true constants only (literals, regexes, etc.).
- Module-level `let`: forbidden.
- Module-level side-effects (file reads, env access): forbidden.

## Design Decision Flowchart

1. **Need a stage?** -- Create an `EffectStage<R>` with the smallest set of service requirements that express the capability.
2. **Is there pure decision logic worth testing on its own?** -- Extract `planXxx()` and an optional plan type. Otherwise keep the pure logic inline or in smaller pure helpers.
3. **Would execution require primitive filesystem/process/Docker I/O or manual cleanup?** -- Create or reuse a domain service first. Do not call primitive services directly from the stage.
4. **Is there already an intentful service method for the job?** -- Call that service from the stage and keep the stage focused on orchestration.
5. **Does the service return a long-lived handle?** -- Register cleanup with `Effect.acquireRelease` or `Effect.addFinalizer`.
6. **Adding a new service?** -- Put Tag + Live + Fake in `src/stages/<owning-stage>/<name>_service.ts` (or `src/services/` only for truly cross-cutting primitives). Re-export from the stage barrel. Add the service to the `StageServices` union in `pipeline/types.ts`.
7. **Adding/modifying an agent?** -- Follow the same split: I/O in `resolve*Probes()`, pure logic in `configure*()`, lifecycle work in services.
