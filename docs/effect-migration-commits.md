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

## Phase 2: Stage Migration (1 stage 1 commit) ✅ Done

Commits 7-16 完了。全 stage を EffectStage の形に変換済み。
ただし一部の stage が Service を経由せず直接 I/O 関数を呼んでいる問題あり → Phase 2.5 で修正。

---

## Phase 2.5: Service 完全化 (stage から直接 I/O を排除)

Phase 2 で EffectStage の形にはなったが、以下の stage が Service を経由せず直接 I/O を呼んでいる:
- **docker_build**: `node:fs/promises` を直接使用 (temp dir 操作)
- **dind**: `ensureDindSidecar`/`teardownDindSidecar` を直接呼出
- **proxy**: `SessionBroker`, `ensureAuthRouterDaemon`, `renderEnvoyConfig`, `gcNetworkRuntime`, `ensureSharedEnvoy` を直接呼出
- **hostexec**: `HostExecBroker`, `writeHostExecSessionRegistry` 等を直接呼出
- **session_store**: `createSession`/`deleteSession`/`ensureSessionRuntimePaths` を直接呼出

### Commit 17: feat(services): extend FsService with readFile, rename, mkdtemp

**Scope**: FsService に不足メソッドを追加。`readFile` は envoy template 読込や asset 読込に必要。`rename` は atomic write に必要。`mkdtemp` は一時ディレクトリ作成に必要。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/fs.ts` | modify | Tag に `readFile`, `rename`, `mkdtemp` を追加。Live/Fake も対応更新 |

**Dependencies**: なし
**Risks**: 低 — 既存メソッドに影響なし

---

### Commit 18: feat(services): extend DockerService with stop, exec, containerIp, volumeCreate, volumeRemove

**Scope**: DockerService に DinD / Proxy で必要な Docker 操作メソッドを追加。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/docker.ts` | modify | Tag に `stop`, `exec`, `containerIp`, `volumeCreate`, `volumeRemove` を追加。Live は `docker/client.ts` に委譲。Fake も対応更新 |

**Dependencies**: なし
**Risks**: 低 — `exec` の返り値型は `string` (stdout)。exit code は Live 内で非 0 なら throw

---

### Commit 19: feat(services): create DindService

**Scope**: DinD sidecar ライフサイクルを抽象化。Live は `docker/dind.ts` の `ensureDindSidecar`/`teardownDindSidecar` に委譲。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/dind.ts` | create | `DindService` Tag (`ensureSidecar`, `teardownSidecar`), `DindServiceLive`, `makeDindServiceFake()` |

**Dependencies**: なし
**Risks**: 低 — 既存関数の薄いラッパー

---

### Commit 20: feat(services): create SessionBrokerService

**Scope**: Proxy の SessionBroker ライフサイクル + registry 操作を抽象化。`start()` は broker 起動 + registry 書込を行い、`SessionBrokerHandle` を返す。Handle の `close()` は broker 停止 + registry/pending 削除。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/session_broker.ts` | create | `SessionBrokerService` Tag, `SessionBrokerHandle`, `SessionBrokerConfig`, Live, Fake |

**Dependencies**: なし
**Risks**: 中 — Live の `start` 内で registry 書込失敗時の broker 巻き戻しが必要 (現在 proxy.ts にあるロジック)

---

### Commit 21: feat(services): create HostExecBrokerService

**Scope**: HostExec の broker ライフサイクル + registry 操作を抽象化。SessionBrokerService と同パターン。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/hostexec_broker.ts` | create | `HostExecBrokerService` Tag, `HostExecBrokerHandle`, `HostExecBrokerConfig`, Live, Fake |

**Dependencies**: なし
**Risks**: 低 — Commit 20 と同パターン

---

### Commit 22: feat(services): create AuthRouterService

**Scope**: Proxy の auth-router daemon ライフサイクルを抽象化。`ensureDaemon()` は daemon 起動 (既に起動中なら再利用) し、`AuthRouterHandle` を返す。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/auth_router.ts` | create | `AuthRouterService` Tag, `AuthRouterHandle` (`abort`), Live (→ `network/envoy_auth_router.ts` 委譲), Fake |

**Dependencies**: なし
**Risks**: 低 — `ensureAuthRouterDaemon` が null を返す場合 (既に起動中) は handle.abort が no-op

---

### Commit 23: feat(services): create SessionStoreService

**Scope**: Session record の CRUD を抽象化。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/services/session_store.ts` | create | `SessionStoreService` Tag (`ensurePaths`, `create`, `delete`), Live (→ `session/store.ts` 委譲), Fake |

**Dependencies**: なし
**Risks**: 低

---

### Commit 24: refactor(stage): DockerBuildStage — node:fs/promises → FsService

**Scope**: `extractAssetsToTempDir` を FsService 経由に書き換え。stage 型を `EffectStage<FsService | DockerService>` に変更。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/docker_build.ts` | modify | `node:fs/promises` import 削除。`mkdtemp`/`readFile`/`mkdir`/`writeFile`/`rm` → FsService |
| `src/stages/docker_build_test.ts` | modify | run() テストで FsService fake + DockerService fake を注入し、各メソッド呼出を検証 |
| `src/pipeline/types.ts` | modify | StageServices に追加不要 (FsService, DockerService は既存) |
| `src/cli.ts` | modify | 変更不要 (liveLayer に FsService は既存) |

**Dependencies**: Commit 17 (FsService readFile, mkdtemp)
**Risks**: 低

---

### Commit 25: refactor(stage): DindStage — ensureDindSidecar → DindService

**Scope**: 直接呼出を DindService 経由に置換。stage 型を `EffectStage<DindService>` に変更。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/dind.ts` | modify | `docker/dind.ts` import 削除。DindService を yield* で取得し acquireRelease 内で使用 |
| `src/stages/dind_test.ts` | modify | run() テストで DindService fake を注入。ensureSidecar の引数検証、scope close 時の teardownSidecar 呼出検証 |
| `src/pipeline/types.ts` | modify | StageServices に `DindService` を追加 |
| `src/cli.ts` | modify | liveLayer に `DindServiceLive` を追加 |

**Dependencies**: Commit 19 (DindService)
**Risks**: 低

---

### Commit 26: refactor(stage): ProxyStage — 全直接 I/O を Service 経由に

**Scope**: 最も大きな書き換え。5 つの sub-resource すべてを Service 経由にする:
1. `gcNetworkRuntime` → FsService (PID 読込 + ファイル削除) + ProcessService (プロセス生存確認)
2. `renderEnvoyConfig` → FsService (`readFile` + `writeFile`)
3. `SessionBroker` → SessionBrokerService
4. `ensureAuthRouterDaemon` → AuthRouterService
5. `ensureSharedEnvoy` + session network → DockerService

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/proxy.ts` | modify | `SessionBroker`, `ensureAuthRouterDaemon`, `renderEnvoyConfig`, `gcNetworkRuntime`, `ensureSharedEnvoy`, `createProxySessionNetworkHandle`, registry 関数の直接 import を全削除。各 Service 経由に書き換え |
| `src/stages/proxy_test.ts` | modify | run() テストで全 Service の fake を注入。各 sub-resource の Service 呼出を検証 |
| `src/pipeline/types.ts` | modify | StageServices に `SessionBrokerService`, `AuthRouterService` を追加 |
| `src/cli.ts` | modify | liveLayer に `SessionBrokerServiceLive`, `AuthRouterServiceLive` を追加 |

**Dependencies**: Commits 17-18 (FsService/DockerService 拡張), 20 (SessionBrokerService), 22 (AuthRouterService)
**Risks**: 高 — 最複雑 stage。gcNetworkRuntime の FsService + ProcessService 分解が最も手間

---

### Commit 27: refactor(stage): HostExecStage — HostExecBroker → HostExecBrokerService

**Scope**: broker ライフサイクルを HostExecBrokerService 経由に。registry 操作は Service 内に吸収済み。stage 型を `EffectStage<FsService | HostExecBrokerService>` に変更。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/hostexec.ts` | modify | `HostExecBroker`, `writeHostExecSessionRegistry`, `removeHostExecSessionRegistry`, `removeHostExecPendingDir` の直接 import 削除。HostExecBrokerService 経由に |
| `src/stages/hostexec_test.ts` | modify | run() テストで FsService fake + HostExecBrokerService fake を注入。broker start 呼出・handle close 呼出を検証 |
| `src/pipeline/types.ts` | modify | StageServices に `HostExecBrokerService` を追加 |
| `src/cli.ts` | modify | liveLayer に `HostExecBrokerServiceLive` を追加 |

**Dependencies**: Commit 21 (HostExecBrokerService)
**Risks**: 低 — broker lifecycle ロジックは Service Live に移動するだけ

---

### Commit 28: refactor(stage): SessionStoreStage — createSession/deleteSession → SessionStoreService

**Scope**: session CRUD を SessionStoreService 経由に。stage 型を `EffectStage<SessionStoreService>` に変更。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/stages/session_store.ts` | modify | `session/store.ts` の直接 import 削除。SessionStoreService 経由に。`resolveNasBinPath` はそのまま維持 (env var probe) |
| `src/stages/session_store_test.ts` | modify | run() テストで SessionStoreService fake を注入。create/delete 呼出を検証 |
| `src/pipeline/types.ts` | modify | StageServices に `SessionStoreService` を追加 |
| `src/cli.ts` | modify | liveLayer に `SessionStoreServiceLive` を追加 |

**Dependencies**: Commit 23 (SessionStoreService)
**Risks**: 低

---

### Commit 29: chore: verify no direct I/O remains in stages

**Scope**: grep で全 stage ファイルから直接 I/O import が残っていないことを確認。問題があれば修正。

**確認項目**:
- `node:fs/promises` — stage ファイルから消えていること
- `ensureDindSidecar` / `teardownDindSidecar` — dind.ts から消えていること
- `SessionBroker` (from network/broker) — proxy.ts から消えていること
- `HostExecBroker` (from hostexec/broker) — hostexec.ts から消えていること
- `ensureAuthRouterDaemon` — proxy.ts から消えていること
- `createSession` / `deleteSession` (from session/store) — session_store.ts から消えていること
- `renderEnvoyConfig` / `gcNetworkRuntime` / `ensureSharedEnvoy` — proxy.ts から消えていること

**Risks**: なし — 検証のみ

---

## Phase 3: Switchover & Cleanup

### Commit 30: refactor(cli): switch to Effect-based pipeline execution

**Scope**: adapter 経由の runPipeline を `runPipelineEffect` + `Effect.scoped` + `Layer.mergeAll` に置換。全 Live Layer (汎用 4 + ドメイン固有 5) を provide。

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/cli.ts` | modify | effectStageAdapter 除去。runPipelineEffect + Effect.scoped + Layer.mergeAll で直接実行 |
| `src/cli/rebuild.ts` | modify | 同様に Effect 実行に統一 |

**Dependencies**: commits 17-29

---

### Commit 31: refactor(pipeline): delete old runPipeline and adapter

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/pipeline/pipeline.ts` | modify | 旧 runPipeline, mergeOutputs, TeardownEntry 削除。runPipelineEffect のみ残す |
| `src/pipeline/effect_adapter.ts` | delete | adapter shim 不要 |
| `src/pipeline/pipeline_test.ts` | modify | 旧 runPipeline テスト削除 |

---

### Commit 32: refactor(types): remove PlanStage, ProceduralStage, ResourceEffect

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/pipeline/types.ts` | modify | PlanStage, ProceduralStage, ProceduralResult, StagePlan, ResourceEffect (14 subtypes), ReadinessCheck, ListenerSpec 削除。AnyStage = EffectStage<StageServices> |
| `src/pipeline/types_test.ts` | modify | 旧型テスト削除 |

---

### Commit 33: chore: delete src/pipeline/effects/ directory and barrel

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `src/pipeline/effects/` | delete | ディレクトリごと削除 (executor, fs, process, docker, unix_listener, proxy, dind, dbus, types) |
| `src/pipeline/effects.ts` | delete | barrel re-export |
| `src/pipeline/effects_integration_test.ts` | modify | 移行 or 削除 |

---

### Commit 34: docs(skill): update SKILL.md for new architecture

**Files**:
| File | Action | Description |
|------|--------|-------------|
| `skills/effect-separation/SKILL.md` | modify | PlanStage/ProceduralStage → EffectStage<R> + Service パターン + acquireRelease パターンに更新 |
