# Effect.ts Migration — Commit Plan

## Phase 1: Foundation (non-breaking additions)

### Commit 1: feat(services): add FsService tag and live implementation

**Scope**: Create `src/services/fs.ts` with FsService Context.Tag, FsServiceLive Layer backed by `node:fs/promises`, and `makeFsServiceFake()` for testing.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/fs.ts` | create | FsService Tag (mkdir, writeFile, chmod, symlink, rm, stat, exists), FsServiceLive Layer, makeFsServiceFake() with in-memory map. Pattern borrowed from `src/pipeline/effects/fs.ts`. |

**Dependencies**: none
**Risks**: none — purely additive

---

### Commit 2: feat(services): add ProcessService tag and live implementation

**Scope**: Create `src/services/process.ts` with ProcessService Context.Tag. `SpawnHandle.exited` returns `Effect.Effect<number>` (not `Promise<number>`) for proper fiber cancellation.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/process.ts` | create | ProcessService Tag (spawn → SpawnHandle, waitForFileExists, exec), ProcessServiceLive using Bun.spawn, makeProcessServiceFake(). |

**Dependencies**: none
**Risks**: none — purely additive

---

### Commit 3: feat(services): add DockerService tag and live implementation

**Scope**: Create `src/services/docker.ts` with DockerService Context.Tag wrapping docker CLI operations. Live layer delegates to existing `src/docker/client.ts`.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/docker.ts` | create | DockerService Tag (build, runInteractive, runDetached, isRunning, containerExists, rm, logs, networkCreate, networkConnect, networkDisconnect, networkRemove), DockerServiceLive, makeDockerServiceFake(). |

**Dependencies**: none
**Risks**: none — purely additive

---

### Commit 4: feat(services): add PromptService tag for worktree prompts

**Scope**: Create `src/stages/worktree/prompt_service.ts`. Live layer delegates to existing `prompts.ts` functions.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/worktree/prompt_service.ts` | create | PromptService Tag (worktreeAction, dirtyWorktreeAction, branchAction, reuseWorktree, renameBranchPrompt), PromptServiceLive, makePromptServiceFake(). |

**Dependencies**: none
**Risks**: none — purely additive

---

### Commit 5: feat(pipeline): add EffectStage type and adapter shim

**Scope**: Add `EffectStage<R>` interface and `effectStageAdapter()` that wraps EffectStage as ProceduralStage so the old `runPipeline` can execute migrated stages during Phase 2.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/pipeline/types.ts` | modify | Add `EffectStage<R>` (kind: 'effect'), `EffectStageResult`, `StageServices` union, `StageServicesOf`, `PipelineRequirements`. Update `AnyStage` to include `EffectStage<StageServices>`. Keep all old types. |
| `src/pipeline/effect_adapter.ts` | create | `effectStageAdapter(stage, layer): ProceduralStage` — wraps EffectStage.run() in `Effect.scoped` + `Effect.provide(layer)`. Also exports `adaptStages()` helper. |
| `src/pipeline/types_test.ts` | modify | Add type-level tests for EffectStage. |

**Dependencies**: commits 1-4 (services must exist for StageServices type)
**Risks**: AnyStage type change — old runPipeline dispatches on 'plan' vs else, so 'effect' kind falls into ProceduralStage branch. Adapter makes this explicit.

---

### Commit 6: feat(pipeline): add Effect-based runPipelineEffect

**Scope**: Add `runPipelineEffect` function that natively runs `EffectStage[]` using `Effect.gen`, alongside the old `runPipeline`.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/pipeline/pipeline.ts` | modify | Add `runPipelineEffect<TStages>(stages, input) → Effect.Effect<PriorStageOutputs, unknown, Scope.Scope \| PipelineRequirements<TStages>>`. Old runPipeline unchanged. |
| `src/pipeline/pipeline_test.ts` | modify | Add tests for runPipelineEffect with simple EffectStage<never> stages. |

**Dependencies**: commit 5
**Risks**: none — additive only

---

## Phase 2: Stage Migration (1 stage 1 commit)

Each commit: migrate stage + update tests + wrap with `effectStageAdapter` in cli.ts.

### Commit 7: refactor(stage): migrate NixDetectStage to EffectStage<never>

**Scope**: Pure logic stays in `planNixDetect()`. `run()` wraps result in `Effect.succeed`.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/nix_detect.ts` | modify | PlanStage → EffectStage<never>. run() calls existing pure planner, returns Effect.succeed(result). |
| `src/stages/nix_detect_test.ts` | modify | Tests call `Effect.runPromise(Effect.scoped(stage.run(input)))`. |
| `src/cli.ts` | modify | Wrap NixDetectStage with `effectStageAdapter()`. Import Layer.mergeAll for live layer. |

**Dependencies**: commit 5 (adapter), commit 6
**Risks**: low — no I/O effects

---

### Commit 8: refactor(stage): migrate DockerBuildStage to EffectStage<DockerService>

**Scope**: Pure planner returns `DockerBuildPlan` (no effects array). `run()` calls `DockerService.build()`. Also updates `rebuild.ts`.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/docker_build.ts` | modify | Add DockerBuildPlan type. Factory returns EffectStage<DockerService>. run() calls planDockerBuild then DockerService.build. |
| `src/stages/docker_build_test.ts` | modify | Planner tests check DockerBuildPlan. Add run() test with DockerService fake layer. |
| `src/cli.ts` | modify | Wrap with effectStageAdapter. |
| `src/cli/rebuild.ts` | modify | Call stage.run() via Effect.scoped + Effect.provide(DockerServiceLive) instead of executePlan/teardownHandles. |

**Dependencies**: commit 5, commit 3
**Risks**: rebuild.ts changes direct executePlan usage — verify rebuild subcommand

---

### Commit 9: refactor(stage): migrate LaunchStage to EffectStage<DockerService>

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/launch.ts` | modify | LaunchPlan type. Factory returns EffectStage<DockerService>. run() calls DockerService.runInteractive. |
| `src/stages/launch_test.ts` | modify | Update tests for LaunchPlan and EffectStage. |
| `src/cli.ts` | modify | Wrap with effectStageAdapter. |

**Dependencies**: commit 5, commit 3

---

### Commit 10: refactor(stage): migrate MountStage to EffectStage<FsService>

**Scope**: Pure planner returns `MountPlan` with directories/files/symlinks instead of `ResourceEffect[]`. `run()` calls FsService operations + `Effect.addFinalizer` for cleanup.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/mount.ts` | modify | MountPlan type (directories, files, symlinks, dockerArgs, envVars, outputOverrides). run() executes via FsService with Effect.addFinalizer. |
| `src/stages/mount_test.ts` | modify | Planner tests check MountPlan. Add run() test with FsService fake. |
| `src/cli.ts` | modify | Wrap with effectStageAdapter. |

**Dependencies**: commit 5, commit 1
**Risks**: MountStage has many effects — careful mapping needed

---

### Commit 11: refactor(stage): migrate DbusProxyStage to EffectStage<FsService | ProcessService>

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/dbus_proxy.ts` | modify | DbusProxyPlan type. run() uses FsService for dirs, ProcessService.spawn + Effect.acquireRelease for proxy process, ProcessService.waitForFileExists for readiness. |
| `src/cli.ts` | modify | Wrap with effectStageAdapter. |

**Dependencies**: commit 5, commits 1-2
**Risks**: Process lifecycle — ensure acquireRelease correctly kills process on scope close

---

### Commit 12: refactor(stage): migrate DindStage to EffectStage<DockerService>

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/dind.ts` | modify | DindPlan type. run() wraps ensureDindSidecar/teardownDindSidecar in Effect.acquireRelease. |
| `src/stages/dind_test.ts` | modify | Update tests. |
| `src/cli.ts` | modify | Wrap with effectStageAdapter. |

**Dependencies**: commit 5, commit 3
**Risks**: shared vs non-shared sidecar teardown logic

---

### Commit 13: refactor(stage): migrate HostExecStage to EffectStage<FsService>

**Scope**: Unix-listener effect (HostExecBroker lifecycle) replaced by direct broker management inside `run()` using `Effect.acquireRelease`. No HostExecDeps pattern.

**Broker lifecycle (from src/pipeline/effects/unix_listener.ts)**:
- **acquire**: `new HostExecBroker({...})` → `broker.start(socketPath)` → `writeHostExecSessionRegistry()`. If registry write fails, close broker.
- **release**: `broker.close()` → `removeHostExecSessionRegistry()` → `removeHostExecPendingDir()`.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/hostexec.ts` | modify | HostExecPlan type (directories, files, symlinks, dockerArgs, envVars — no effects[]). run() calls FsService for dirs/files/symlinks, then Effect.acquireRelease for HostExecBroker lifecycle. |
| `src/stages/hostexec_test.ts` | modify | Planner tests for HostExecPlan. run() test with FsService fake verifying broker lifecycle. |
| `src/cli.ts` | modify | Wrap with effectStageAdapter. |

**Dependencies**: commit 5, commit 1
**Risks**: Broker lifecycle must exactly match unix_listener.ts behavior including partial-failure recovery

---

### Commit 14: refactor(stage): migrate ProxyStage to EffectStage<FsService | DockerService>

**Scope**: Proxy-session effect decomposed into 5 chained `Effect.acquireRelease` calls.

**Sub-resources (from src/pipeline/effects/proxy.ts)**:
1. `gcNetworkRuntime` + `renderEnvoyConfig` via FsService
2. `SessionBroker.start()` + `writeSessionRegistry()` (release: broker.close + registry remove)
3. `ensureAuthRouterDaemon` (release: process kill)
4. `ensureSharedEnvoy` via DockerService (release: container rm if not shared)
5. Session network create + envoy/dind connect via DockerService (release: network disconnect + remove)

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/proxy.ts` | modify | ProxyPlan type (pure config data). run() chains acquireRelease for 5 sub-resources. |
| `src/stages/proxy_test.ts` | modify | Planner tests for ProxyPlan. run() test verifying lifecycle. |
| `src/cli.ts` | modify | Wrap with effectStageAdapter. |

**Dependencies**: commit 5, commits 1, 3
**Risks**: Most complex stage — many sub-resources with intricate rollback. Must replicate error-recovery logic from effects/proxy.ts.

---

### Commit 15: refactor(stage): migrate SessionStoreStage to EffectStage<FsService>

**Scope**: ProceduralStage class → plain object. `resolveNasBinPath` stays as direct sync I/O (probe-like check).

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/session_store.ts` | modify | Class → createSessionStoreStage() factory. run() uses Effect.addFinalizer for deleteSession. |
| `src/stages/session_store_test.ts` | modify | Update for EffectStage interface. |
| `src/cli.ts` | modify | Replace `new SessionStoreStage()` with factory + adapter. |

**Dependencies**: commit 5, commit 1

---

### Commit 16: refactor(stage): migrate WorktreeStage to EffectStage<PromptService | FsService | ProcessService>

**Scope**: ProceduralStage class → plain object. Prompts via PromptService, git via ProcessService.exec, files via FsService. Cherry-pick temp worktree via nested `Effect.acquireRelease`.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/worktree/stage.ts` | modify | Class → createWorktreeStage() factory. Effect.gen body replaces execute() logic. |
| `src/stages/worktree.ts` | modify | Update barrel export. |
| `src/cli.ts` | modify | Replace `new WorktreeStage()` with factory + adapter. |

**Dependencies**: commit 5, commits 1-2, 4
**Risks**: Most complex ProceduralStage — extensive branching, error recovery

---

## Phase 3: Switchover & Cleanup

### Commit 17: refactor(cli): switch to Effect-based pipeline execution

**Scope**: Replace adapter-based runPipeline with `runPipelineEffect` + `Effect.scoped` + `Layer.mergeAll`. Use `Effect.runPromiseExit` for `exitOnCliError` compatibility.

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/cli.ts` | modify | Remove effectStageAdapter wrapping. Use runPipelineEffect directly with Effect.scoped + Layer.mergeAll(FsServiceLive, ProcessServiceLive, DockerServiceLive, PromptServiceLive). |
| `src/cli/rebuild.ts` | modify | Verify consistency with cli.ts pattern. |

**Dependencies**: commits 7-16

---

### Commit 18: refactor(pipeline): delete old runPipeline and adapter

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/pipeline/pipeline.ts` | modify | Remove old runPipeline, mergeOutputs, TeardownEntry. Keep only runPipelineEffect. |
| `src/pipeline/effect_adapter.ts` | delete | Adapter shim no longer needed. |
| `src/pipeline/pipeline_test.ts` | modify | Remove old runPipeline tests. |

---

### Commit 19: refactor(types): remove PlanStage, ProceduralStage, ResourceEffect

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/pipeline/types.ts` | modify | Delete PlanStage, ProceduralStage, ProceduralResult, StagePlan, ResourceEffect (all 14 subtypes), ReadinessCheck, ListenerSpec. AnyStage = EffectStage<StageServices>. |
| `src/pipeline/types_test.ts` | modify | Remove tests for old types. |

---

### Commit 20: chore: delete src/pipeline/effects/ directory and barrel

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/pipeline/effects/executor.ts` | delete | Replaced by stages calling services directly. |
| `src/pipeline/effects/fs.ts` | delete | Replaced by FsService. |
| `src/pipeline/effects/process.ts` | delete | Replaced by ProcessService. |
| `src/pipeline/effects/docker.ts` | delete | Replaced by DockerService. |
| `src/pipeline/effects/unix_listener.ts` | delete | Replaced by acquireRelease in HostExecStage. |
| `src/pipeline/effects/proxy.ts` | delete | Replaced by acquireRelease in ProxyStage. |
| `src/pipeline/effects/proxy_test.ts` | delete | Moved to stage-level tests. |
| `src/pipeline/effects/dind.ts` | delete | Replaced by DockerService in DindStage. |
| `src/pipeline/effects/dbus.ts` | delete | Replaced by services in DbusProxyStage. |
| `src/pipeline/effects/types.ts` | delete | ResourceHandle no longer needed. |
| `src/pipeline/effects.ts` | delete | Barrel re-export. |
| `src/pipeline/effects_integration_test.ts` | modify | Migrate or remove. |

---

### Commit 21: docs(skill): update SKILL.md for new architecture

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `skills/effect-separation/SKILL.md` | modify | Replace PlanStage/ProceduralStage docs with EffectStage<R> pattern, Service usage, Effect.acquireRelease pattern. |
