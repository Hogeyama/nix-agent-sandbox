# Effect.ts 導入 — 移行プラン (v2)

起点コミット: `d80cf87` (main)

## 背景と動機

`src/pipeline/` の現行アーキテクチャには副作用の扱いに根本的な問題がある。

### 現状 (d80cf87)

- **PlanStage**: 純粋 planner が `StagePlan { effects: ResourceEffect[], dockerArgs, envVars, outputOverrides }` を返す。`runPipeline` が `executePlan()` → `teardownHandles()` で実行。8 stage が使用。
- **ProceduralStage**: `execute()` / `teardown()` で直接副作用を実行。WorktreeStage, SessionStoreStage が使用。

### 問題

現行 pipeline には、`PlanStage` と `ProceduralStage` という 2 つの実行モデルがある。`PlanStage` はまず `StagePlan` というデータを組み立て、それを executor が解釈して実行する。`ProceduralStage` は stage 自身が副作用を順番に実行し、teardown も自分で管理する。

`PlanStage` が向いているのは、入力から実行手順を最初にすべて決められる stage だけである。実際の stage では、途中で得た値や成否に応じて次の処理を変える、resource の acquire と release を近い場所に置く、条件分岐や再試行を含む flow を組み立てる、といった逐次的な制御が必要になる。`StagePlan` は「先に副作用の一覧を作る」一段の DSL なので、この種の flow を自然に表現できない。Haskell 的に言えば bind (`>>=`) がなく、effectful な計算を段階的につないでいけない。

そのため、複雑な stage は `PlanStage` に収まらず、`ProceduralStage` という escape hatch を必要とする。結果として、宣言的な DSL を executor が解釈する流れと、stage 自身が副作用を実行する流れが併存し、resource 管理・エラーハンドリング・テストの書き方が二重化している。


### 方針

**`StagePlan` / `ResourceEffect` DSL を全廃**し、stage 自体を `Effect.Effect` として記述する。I/O は **Effect Service (`Context.Tag` + `Layer`)** で抽象化し、resource の acquire/release は `Scope` に委譲する。全 stage は `EffectStage<R>` に統一され、テストでは Fake Layer を差し替える。

## 到達点

- `AnyStage = EffectStage<StageServices>` — stage 種別は 1 つだけ
- `PlanStage` / `ProceduralStage` / `ResourceEffect` / `executePlan` / `teardownHandles` が完全に消滅
- 各 stage は `EffectStage<R>` として宣言され、`R` から要求 service が読める
- `Scope.Scope` は `acquireRelease` / `addFinalizer` 用の実行基盤であり、stage 固有依存の議論には含めない
- `runPipeline` は `Effect.Effect<PriorStageOutputs, unknown, PipelineRequirements<TStages>>` を返す
- teardown 管理は Effect の `Scope` に完全委譲（手動 `teardowns[]` 配列は廃止）
- 汎用 `StagePlan` / `fromStagePlan` は削除し、planner は stage-local plan 型 (`MountPlan`, `ProxyPlan` など) を返す
- I/O は **すべて** Service 経由。stage の `run()` から `node:fs/promises`, `Bun.spawn`, docker CLI 関数, broker クラス等を直接呼ばない
- 汎用 Service: `FsService` / `ProcessService` / `DockerService` / `PromptService`
- ドメイン固有 Service: `DindService` / `SessionBrokerService` / `HostExecBrokerService` / `AuthRouterService` / `SessionStoreService`

## 設計決定

| # | 項目 | 決定 | 理由 |
|---|---|---|---|
| 1 | Scope の持ち方 | `runPipeline` を Effect 化、`cli.ts` で `Effect.scoped` | pipeline 全体が単一 Scope |
| 2 | Service 粒度 | 汎用 Service (Fs / Process / Docker / Prompt) + ドメイン固有 Service (DindService, SessionBrokerService, HostExecBrokerService, AuthRouterService, SessionStoreService) | 汎用 I/O はドメイン境界で分割。broker・sidecar 等の複合ライフサイクルは専用 Service で抽象化し、stage から直接 I/O を呼ばない。テストで fake 注入を保証する |
| 3 | 純粋 planner | 維持。返り値を stage-local 型に変更 (effects 除去) | テスタビリティ維持。planner テストは Effect 不要 |
| 4 | エラーチャンネル | `unknown` で開始 | 将来 `Data.TaggedError` に狭める余地を残す |
| 5 | Scope の見せ方 | `Scope.Scope` は `run()` の Effect 環境側だけに出し、stage の型引数 `R` には含めない | finalizer 用の共通基盤と stage 固有 service を分離し、`EffectStage<R>` を読めば依存 service が分かるようにする |

## Service 定義

### FsService

```typescript
// src/services/fs.ts
export class FsService extends Context.Tag("nas/FsService")<
  FsService,
  {
    readonly mkdir: (path: string, opts: { recursive?: boolean; mode?: number }) => Effect.Effect<void>;
    readonly writeFile: (path: string, content: string, opts?: { mode?: number }) => Effect.Effect<void>;
    readonly readFile: (path: string) => Effect.Effect<string>;
    readonly chmod: (path: string, mode: number) => Effect.Effect<void>;
    readonly symlink: (target: string, path: string) => Effect.Effect<void>;
    readonly rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Effect.Effect<void>;
    readonly rename: (oldPath: string, newPath: string) => Effect.Effect<void>;
    readonly stat: (path: string) => Effect.Effect<import("node:fs").Stats>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
  }
>() {}
```

使用 stage: Mount, DbusProxy, Proxy, HostExec, Worktree, SessionStore, DockerBuild

### ProcessService

```typescript
// src/services/process.ts
export interface SpawnHandle {
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

export class ProcessService extends Context.Tag("nas/ProcessService")<
  ProcessService,
  {
    readonly spawn: (command: string, args: string[]) => Effect.Effect<SpawnHandle>;
    readonly waitForFileExists: (path: string, timeoutMs: number, pollIntervalMs: number) => Effect.Effect<void>;
    readonly exec: (cmd: string[], opts?: { cwd?: string }) => Effect.Effect<string>;
  }
>() {}
```

使用 stage: DbusProxy, Worktree

### DockerService

```typescript
// src/services/docker.ts
export class DockerService extends Context.Tag("nas/DockerService")<
  DockerService,
  {
    readonly build: (contextDir: string, imageName: string, labels: Record<string, string>) => Effect.Effect<void>;
    readonly runInteractive: (opts: DockerRunOpts) => Effect.Effect<void>;
    readonly runDetached: (opts: DockerRunDetachedOpts) => Effect.Effect<string>;
    readonly isRunning: (name: string) => Effect.Effect<boolean>;
    readonly containerExists: (name: string) => Effect.Effect<boolean>;
    readonly rm: (name: string) => Effect.Effect<void>;
    readonly stop: (name: string, opts?: { timeoutSeconds?: number }) => Effect.Effect<void>;
    readonly exec: (container: string, cmd: string[], opts?: { user?: string }) => Effect.Effect<string>;
    readonly logs: (name: string, opts?: { tail?: number }) => Effect.Effect<string>;
    readonly containerIp: (name: string) => Effect.Effect<string>;
    readonly volumeCreate: (name: string, opts?: { labels?: Record<string, string> }) => Effect.Effect<void>;
    readonly volumeRemove: (name: string) => Effect.Effect<void>;
    readonly networkCreate: (name: string, opts: { internal?: boolean; labels?: Record<string, string> }) => Effect.Effect<void>;
    readonly networkConnect: (network: string, container: string, opts?: { aliases?: string[] }) => Effect.Effect<void>;
    readonly networkDisconnect: (network: string, container: string) => Effect.Effect<void>;
    readonly networkRemove: (network: string) => Effect.Effect<void>;
  }
>() {}
```

使用 stage: DockerBuild, Launch, Dind, Proxy

### PromptService (新設)

```typescript
// src/stages/worktree/prompt_service.ts
export class PromptService extends Context.Tag("nas/PromptService")<
  PromptService,
  {
    readonly worktreeAction: (path: string) => Effect.Effect<WorktreeAction>;
    readonly dirtyWorktreeAction: (path: string) => Effect.Effect<DirtyWorktreeAction | null>;
    readonly branchAction: (branch: string | null, base: string | null, root: string | null) => Effect.Effect<BranchAction>;
    readonly reuseWorktree: (entries: readonly WorktreeEntry[]) => Effect.Effect<WorktreeEntry | null>;
    readonly renameBranchPrompt: (current: string) => Effect.Effect<string | null>;
  }
>() {}
```

使用 stage: Worktree

### DindService (新設)

```typescript
// src/services/dind.ts
export interface DindSidecarOpts {
  readonly containerName: string;
  readonly sharedTmpVolume: string;
  readonly networkName: string;
  readonly shared: boolean;
  readonly disableCache: boolean;
  readonly readinessTimeoutMs: number;
}

export class DindService extends Context.Tag("nas/DindService")<
  DindService,
  {
    readonly ensureSidecar: (opts: DindSidecarOpts) => Effect.Effect<void>;
    readonly teardownSidecar: (opts: { containerName: string; networkName: string; sharedTmpVolume: string; shared: boolean }) => Effect.Effect<void>;
  }
>() {}
```

Live 実装は既存の `docker/dind.ts` の `ensureDindSidecar` / `teardownDindSidecar` に委譲。
使用 stage: Dind

### SessionBrokerService (新設)

```typescript
// src/services/session_broker.ts
export interface SessionBrokerHandle {
  readonly close: () => Effect.Effect<void>;
}

export class SessionBrokerService extends Context.Tag("nas/SessionBrokerService")<
  SessionBrokerService,
  {
    readonly start: (socketPath: string, config: SessionBrokerConfig) => Effect.Effect<SessionBrokerHandle>;
  }
>() {}
```

Live 実装は既存の `network/broker.ts` の `SessionBroker` に委譲。
使用 stage: Proxy

### HostExecBrokerService (新設)

```typescript
// src/services/hostexec_broker.ts
export interface HostExecBrokerHandle {
  readonly close: () => Effect.Effect<void>;
}

export class HostExecBrokerService extends Context.Tag("nas/HostExecBrokerService")<
  HostExecBrokerService,
  {
    readonly start: (socketPath: string, config: HostExecBrokerConfig) => Effect.Effect<HostExecBrokerHandle>;
  }
>() {}
```

Live 実装は既存の `hostexec/broker.ts` の `HostExecBroker` に委譲。
使用 stage: HostExec

### AuthRouterService (新設)

```typescript
// src/services/auth_router.ts
export interface AuthRouterHandle {
  readonly abort: () => Effect.Effect<void>;
}

export class AuthRouterService extends Context.Tag("nas/AuthRouterService")<
  AuthRouterService,
  {
    readonly ensureDaemon: (runtimePaths: NetworkRuntimePaths) => Effect.Effect<AuthRouterHandle>;
  }
>() {}
```

Live 実装は既存の `network/envoy_auth_router.ts` の `ensureAuthRouterDaemon` に委譲。
使用 stage: Proxy

### SessionStoreService (新設)

```typescript
// src/services/session_store.ts
export interface SessionStoreService extends Context.Tag("nas/SessionStoreService")<
  SessionStoreService,
  {
    readonly ensurePaths: () => Effect.Effect<SessionRuntimePaths>;
    readonly create: (paths: SessionRuntimePaths, record: SessionRecord) => Effect.Effect<void>;
    readonly delete: (paths: SessionRuntimePaths, sessionId: string) => Effect.Effect<void>;
  }
>() {}
```

Live 実装は既存の `session/store.ts` の `ensureSessionRuntimePaths` / `createSession` / `deleteSession` に委譲。
使用 stage: SessionStore

## 型定義の変更

### pipeline/types.ts

```typescript
import type { Effect, Scope } from "effect";
import type { FsService } from "../services/fs.ts";
import type { ProcessService } from "../services/process.ts";
import type { DockerService } from "../services/docker.ts";
import type { PromptService } from "../stages/worktree/prompt_service.ts";

// --- Stage result ---

export type EffectStageResult = Partial<PriorStageOutputs>;

// --- Stage requirements ---

export type StageServices =
  | PromptService
  | FsService
  | ProcessService
  | DockerService
  | DindService
  | SessionBrokerService
  | HostExecBrokerService
  | AuthRouterService
  | SessionStoreService;

// --- Stage interface ---

export interface EffectStage<R extends StageServices = never> {
  kind: "effect";
  name: string;
  run(input: StageInput): Effect.Effect<EffectStageResult, unknown, Scope.Scope | R>;
}

export type AnyStage = EffectStage<StageServices>;

export type StageServicesOf<TStage extends AnyStage> =
  TStage extends EffectStage<infer R extends StageServices> ? R : never;

export type PipelineRequirements<TStages extends readonly AnyStage[]> =
  Scope.Scope | StageServicesOf<TStages[number]>;

// 汎用 StagePlan は作らない。planner は stage-local plan 型を返す。
```

**削除**: `PlanStage`, `ProceduralStage`, `ProceduralResult`, `StagePlan`, `fromStagePlan`, `ResourceEffect` (14 subtypes すべて), `ReadinessCheck`, `ListenerSpec`

### pipeline/pipeline.ts

```typescript
export function runPipeline<const TStages extends readonly AnyStage[]>(
  stages: TStages,
  input: StageInput,
): Effect.Effect<PriorStageOutputs, unknown, PipelineRequirements<TStages>> {
  return Effect.gen(function* () {
    let prior = { ...input.prior };
    for (const stage of stages) {
      yield* Effect.sync(() => logInfo(`[nas] Running stage: ${stage.name}`));
      const currentInput: StageInput = { ...input, prior };
      const result = yield* stage.run(currentInput);
      prior = {
        ...prior,
        ...result,
      };
    }
    return prior;
  });
}
```

`runPipeline` は planner の存在を知らない。各 stage が内部で `planXxx()` を呼び、service 実行と `EffectStageResult` への変換まで責任を持つ。`dockerArgs` / `envVars` も特別扱いせず、append / replace / merge は各 stage が `input.prior` を見て通常の TypeScript と Effect で組み立てる。

**削除**: `_dockerArgsReplacement`, `mergeEffectOutputs`, `TeardownEntry`, teardowns 配列管理, `executePlan`/`teardownHandles` 呼び出し, `fromStagePlan`

### cli.ts

```typescript
import { FsServiceLive } from "./services/fs.ts";
import { ProcessServiceLive } from "./services/process.ts";
import { DockerServiceLive } from "./services/docker.ts";
import { PromptServiceLive } from "./stages/worktree/prompt_service.ts";

const stages = [
  NixDetectStage,
  createDockerBuildStage(buildProbes),
  createLaunchStage(extraArgs),
  // ...
] as const satisfies readonly AnyStage[];

const exit = await Effect.runPromiseExit(
  runPipeline(stages, input).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(
      FsServiceLive,
      ProcessServiceLive,
      DockerServiceLive,
      PromptServiceLive,
    )),
  ),
);
```

## Stage ごとの変更

`EffectStage<R>` の `R` は stage 固有 service だけを表す。`Scope.Scope` は `acquireRelease` / `addFinalizer` 用の共通基盤なので、この一覧には含めない。

### 純粋 planner 系 — I/O なし (最小変更)

**NixDetectStage (`EffectStage<never>`)**:
- `planNixDetect()` はそのまま純粋関数として維持し、返り値は `EffectStageResult | null` に寄せる。
- `run()` は `Effect.succeed(...)` するだけ。

### 純粋 planner 系 — I/O あり (Service 呼び出しに移行)

**MountStage (`EffectStage<FsService>`)**:
- `planMount` の返り値を `MountPlan` に変更: `effects: ResourceEffect[]` → `directories`, `files`, `symlinks`。
- `run()` 内で `FsService.mkdir` / `writeFile` / `symlink` を呼び、`dockerArgs` / `envVars` は `input.prior` をベースに次状態をそのまま返す。teardown 必要なものは `Effect.addFinalizer`。

**DockerBuildStage (`EffectStage<FsService | DockerService>`)**:
- `planDockerBuild` は `DockerBuildPlan | null` を返す。`docker-image-build` effect 除去。
- `run()` 内で一時ディレクトリ操作は `FsService` (`readFile`, `mkdir`, `writeFile`, `rm`) 経由、ビルドは `DockerService.build()` を呼ぶ。

**LaunchStage (`EffectStage<DockerService>`)**:
- `planLaunch` は `LaunchPlan` を返す。`docker-run-interactive` effect 除去。
- `run()` 内で `DockerService.runInteractive()` を呼ぶ。

**DbusProxyStage (`EffectStage<FsService | ProcessService>`)**:
- `planDbusProxy` は `DbusProxyPlan | null` を返す。`dbus-proxy` / `process-spawn` / `wait-for-ready` effects 除去。
- `run()` 内で `FsService.mkdir` / `writeFile` と `ProcessService.spawn` / `waitForFileExists` を `Effect.acquireRelease` で組み立て。

**DindStage (`EffectStage<DindService>`)**:
- `planDind` は `DindPlan | null` を返す。`dind-sidecar` effect 除去。
- `run()` 内で `DindService.ensureSidecar` / `DindService.teardownSidecar` を `Effect.acquireRelease` で使う。stage は Docker CLI の詳細を知らない。

**ProxyStage (`EffectStage<FsService | DockerService | SessionBrokerService | AuthRouterService>`)**:
- `planProxy` は `ProxyPlan | null` を返す。`proxy-session` effect 除去。
- `run()` 内で:
  - envoy config 描画・registry 操作は `FsService` (`readFile`, `writeFile`, `rm`)
  - broker は `SessionBrokerService.start` → `Effect.acquireRelease`
  - auth-router は `AuthRouterService.ensureDaemon` → `Effect.acquireRelease`
  - envoy container / network は `DockerService` の各メソッド
  - network 差し替え後の `dockerArgs` もここで完成形を返す。

### ProceduralStage 系 (Effect.gen で書き直し)

**WorktreeStage (`EffectStage<PromptService | FsService | ProcessService>`)**:
- class 廃止 → plain object `EffectStage`。
- `Effect.gen` + `PromptService` + `FsService` + `ProcessService`。
- git 操作は `ProcessService.exec` 経由。
- teardown は `Effect.acquireRelease` / `Effect.addFinalizer` で Scope に委譲。

**SessionStoreStage (`EffectStage<SessionStoreService>`)**:
- class 廃止 → plain object `EffectStage`。
- `SessionStoreService` 経由で session record の create/delete を行い、mount 用の `dockerArgs` と `envVars` も完成形で返す。
- `Effect.acquireRelease` で Scope に載せる。

**HostExecStage (`EffectStage<FsService | HostExecBrokerService>`)**:
- wrapper / symlink / runtime path ��� file I/O は `FsService`。
- broker ライフサイクルは `HostExecBrokerService.start` → `Effect.acquireRelease`。
- registry 操作 (JSON write/delete) は `FsService.writeFile` / `FsService.rm`。

### cli/rebuild.ts

- `executePlan` / `teardownHandles` 直接呼び出しを廃止。
- `DockerService` を直接使うか、stage の `run()` を Effect で実行する形に変更。

## 削除対象

| 対象 | パス (d80cf87 基準) |
|---|---|
| effects ディレクトリ全体 | `src/pipeline/effects/` (9 ファイル) |
| barrel re-export | `src/pipeline/effects.ts` |
| ResourceEffect union + 14 subtypes | `types.ts:142-293` |
| 汎用 `StagePlan` / `fromStagePlan` / `_dockerArgsReplacement` | `types.ts`, `pipeline.ts` |
| ProceduralStage / ProceduralResult | `types.ts:94-95, 306-313` |
| PlanStage | `types.ts:299-303` |
| ReadinessCheck | `types.ts:102-108` |
| ListenerSpec | `types.ts:114-137` |
| TeardownEntry / teardowns 配列 | `pipeline.ts` |

## 新規ファイル

| ファイル | 内容 |
|---|---|
| `src/services/fs.ts` | FsService Tag, FsServiceLive, makeFsServiceFake |
| `src/services/process.ts` | ProcessService Tag, ProcessServiceLive, makeProcessServiceFake |
| `src/services/docker.ts` | DockerService Tag, DockerServiceLive, makeDockerServiceFake |
| `src/stages/worktree/prompt_service.ts` | PromptService Tag, Live, Fake |
| `src/services/dind.ts` | DindService Tag, DindServiceLive, makeDindServiceFake |
| `src/services/session_broker.ts` | SessionBrokerService Tag, Live, Fake |
| `src/services/hostexec_broker.ts` | HostExecBrokerService Tag, Live, Fake |
| `src/services/auth_router.ts` | AuthRouterService Tag, Live, Fake |
| `src/services/session_store.ts` | SessionStoreService Tag, Live, Fake |

## 移行順序

### Phase 1: 基盤 (非破壊的追加)

1. `effect` を `package.json` に追加
2. `src/services/fs.ts` — FsService 作成
3. `src/services/process.ts` — ProcessService 作成
4. `src/services/docker.ts` — DockerService 作成
5. `src/stages/worktree/prompt_service.ts` — PromptService 作成
6. `src/pipeline/types.ts` — `EffectStage<R>` / `StageServicesOf<TStage>` / `PipelineRequirements<TStages>` 追加 (旧型と併存)
7. `src/pipeline/pipeline.ts` — tuple から requirements を推論する Effect 版 `runPipeline` 追加

### Phase 2: Stage 移行 (1 stage 1 commit、簡単な順)

8. NixDetectStage → `EffectStage<never>` ✅
9. DockerBuildStage → `EffectStage<DockerService>` ✅ (Phase 2.5 で FsService 追加)
10. LaunchStage → `EffectStage<DockerService>` ✅
11. MountStage → `EffectStage<FsService>` ✅
12. DbusProxyStage → `EffectStage<FsService | ProcessService>` ✅
13. DindStage → `EffectStage<never>` ✅ (Phase 2.5 で DindService に変更)
14. ProxyStage → `EffectStage<FsService | DockerService>` ✅ (Phase 2.5 で broker/auth-router service 追加)
15. SessionStoreStage → `EffectStage<never>` ✅ (Phase 2.5 で SessionStoreService に変更)
16. HostExecStage → `EffectStage<FsService>` ✅ (Phase 2.5 で HostExecBrokerService 追加)
17. WorktreeStage → `EffectStage<PromptService | FsService | ProcessService>` ✅

### Phase 2.5: Service 完全化 (stage から直接 I/O を排除)

Phase 2 で EffectStage の形にはなったが、一部の stage が Service を経由せず直接 I/O 関数を呼んでいる問題を修正する。

#### 既存 Service 拡張
18. FsService に `readFile`, `rename` を追加
19. DockerService に `stop`, `exec`, `containerIp`, `volumeCreate`, `volumeRemove` を追加

#### 新 Service 作成
20. DindService — `ensureSidecar` / `teardownSidecar`。Live は `docker/dind.ts` に委譲
21. SessionBrokerService — `start` → `SessionBrokerHandle`。Live は `network/broker.ts` に委譲
22. HostExecBrokerService — `start` → `HostExecBrokerHandle`。Live は `hostexec/broker.ts` に委譲
23. AuthRouterService — `ensureDaemon` → `AuthRouterHandle`。Live は `network/envoy_auth_router.ts` に委譲
24. SessionStoreService — `ensurePaths` / `create` / `delete`。Live は `session/store.ts` に委譲

#### Stage 修正 (Service 経由に書き換え)
25. DockerBuildStage — `node:fs/promises` → FsService
26. DindStage — `ensureDindSidecar` / `teardownDindSidecar` → DindService
27. ProxyStage — SessionBroker → SessionBrokerService, AuthRouter → AuthRouterService, envoy config → FsService
28. HostExecStage — HostExecBroker → HostExecBrokerService, registry → FsService
29. SessionStoreStage — `createSession` / `deleteSession` → SessionStoreService

### Phase 3: 切り替え・削除

30. `cli.ts` — Effect.scoped + Layer.mergeAll で起動 (新 Service の Live Layer も追加)
31. `cli/rebuild.ts` — Effect 実行に書き換え
32. 旧型 (`PlanStage` / `ProceduralStage` / `ResourceEffect`) 削除
33. `src/pipeline/effects/` ディレクトリ削除
34. `src/pipeline/effects.ts` barrel 削除
35. integration test の `executePlan`/`teardownHandles` 依存を除去
36. 旧 `runPipeline` (Promise 版) 削除

## テスト方針

- **純粋 planner テスト**: 変更なし。`planMount(input)` を呼んで返り値を検査。Effect 不要。
- **Stage テスト**: すべての Service を Fake Layer で provide → `Effect.runPromise(Effect.scoped(stage.run(input)))`。stage の `run()` から直接 I/O を呼ぶコードがあってはならない。
- **Fake で検証すべきこと**: Service メソッドが正しい引数で呼ばれたか（spy パターン）、acquireRelease の release が呼ばれるか。
- **WorktreeStage テスト**: `makePromptServiceFake()` + Service fake Layer で決定的応答を注入。
- **Integration test**: Live Layer で実行。既存の Docker 前提テストはそのまま。

## 完了条件

- [ ] `PlanStage` / `ProceduralStage` / `StagePlan` / `fromStagePlan` / `ResourceEffect` が grep 0 件
- [ ] `runPipeline` が `Effect.Effect<PriorStageOutputs, unknown, PipelineRequirements<TStages>>` を返す
- [ ] `bunx tsc --noEmit` 通過
- [ ] `bun test src/` 通過
- [ ] `bun run compile` 成功
- [ ] `skills/effect-separation/SKILL.md` が新アーキテクチャを反映

## 注意点

- **finalizer 登録は resource 取得直後に**: `Effect.acquireRelease` を使うか、acquire 直後に即 `Effect.addFinalizer`。間に失敗し得る処理を挟まない。
- **finalizer のエラーポリシー**: `Effect.catchAll(() => Effect.logWarning(...))` で finalizer 自身は決して fail しない。teardown エラーは pipeline を失敗させない。
- **`unknown` エラーが cli まで届く**: `Effect.runPromise` の reject は `FiberFailure` で包まれる。`Effect.runPromiseExit` を使い `Exit` から元 Error を取り出すことで `exitOnCliError` との互換を維持する。
- **WorktreeStage の一時 worktree**: `cherryPickDetached()` の一時 worktree も `Effect.acquireRelease` で管理し、cherry-pick 失敗時のリークを防ぐ。
