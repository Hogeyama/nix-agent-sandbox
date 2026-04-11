# Effect.ts 導入 — 移行プラン

## 背景と動機

`src/pipeline/` の現行 stage アーキテクチャは `PlanStage` (pure) と
`ProceduralStage` (side-effectful) の二本立てになっており、`WorktreeStage`
だけが後者を使っている。`ProceduralStage` が残る根本原因は、現状の
`ResourceEffect` DSL が「副作用の配列」であって「副作用のプログラム (bind
を持つ木)」ではないためで、以下のような stage を `PlanStage` では表現できない:

- 結果依存の逐次分岐 (例: `findProfileWorktrees` の結果でプロンプトを出すか判断)
- ユーザ対話 (例: keep/delete/stash の選択)
- teardown 時点の動的状態に基づく判断 (例: dirty かどうかで分岐)

**Effect.ts を導入して `ProceduralStage` を完全に消滅させる**、というのが
本プランの目的である。

関連する既存ドキュメント: `skills/effect-separation/SKILL.md` (本プラン完了時に
全面改訂する)。

## 到達点

- `AnyStage = EffectStage`。stage 種別は 1 つだけ。
- `runPipeline` は `Effect.Effect<PriorStageOutputs, unknown, StageRequirements>`
  を返す。Promise ラッパはない。
- `cli.ts` は `Effect.runPromise(Effect.scoped(runPipeline(...).pipe(Effect.provide(...))))`
  で起動する。
- `WorktreeStage` は `Effect.gen` + `PromptService` + `Effect.tryPromise` で
  git 操作を包む完全書き直し。mutable class state は廃止。
- 既存 `PlanStage` (8 個) は `fromStagePlan` 互換 shim を経由して `EffectStage`
  としてラップする。stage 本体の純粋 planner 関数 (`planMount` 等) には一切
  手を入れない。
- `StagePlan` data 型 / `ResourceEffect` / `executePlan` / `teardownHandles` は
  shim の内部実装として残す。`fromStagePlan` 内で `Effect.acquireRelease` を
  使って Scope に載せる。
- teardown 管理は完全に Scope に委譲する。`pipeline.ts` の `teardowns[]` 配列
  管理コードは削除される。

## 設計決定 (合意済み)

| # | 項目 | 決定 |
|---|---|---|
| 1 | Scope の持ち方 | `runPipeline` 自体を Effect 化し、`cli.ts` で `Effect.scoped` で包む (pipeline 全体が単一の Scope 上で走る) |
| 2 | PlanStage の扱い | 廃止。全 stage を `EffectStage` に統一。既存 PlanStage は `fromStagePlan` shim 経由 |
| 3 | PromptService | `Context.Tag` + `Layer` で注入。Live 実装は既存 `prompts.ts` を薄くラップするだけ |
| 4 | WorktreeStage の粒度 | `Effect.gen` でフル書き直し。git 操作は全て `Effect.tryPromise` |
| 5 | エラーチャンネル | `unknown` で開始。将来 `Data.TaggedError` に狭める余地を残す |

## 型定義の骨格

### `src/pipeline/types.ts`

```typescript
import type { Effect, Scope } from "effect";
import type { PromptService } from "../stages/worktree/prompt_service.ts";

/**
 * Stage 実行結果。
 *
 * - `dockerArgs` (存在する場合) は prior.dockerArgs に append される。
 * - `envVars` (存在する場合) は prior.envVars に merge される。
 * - その他のフィールドは prior に overwrite される。
 */
export interface EffectStageResult extends Partial<PriorStageOutputs> {
  /**
   * Escape hatch: prior.dockerArgs を完全置換してから、上の dockerArgs が
   * append される。PlanStage 互換 shim (`fromStagePlan`) のみが使用する。
   * 通常の EffectStage は触らない。
   */
  readonly _dockerArgsReplacement?: readonly string[];
}

/**
 * Stage が要求し得る Effect Context の union。
 * 新しい service を足すときはここに追加していく。
 */
export type StageRequirements = Scope.Scope | PromptService;

export interface EffectStage {
  kind: "effect";
  name: string;
  run(
    input: StageInput,
  ): Effect.Effect<EffectStageResult, unknown, StageRequirements>;
}

export type AnyStage = EffectStage;

// StagePlan / ResourceEffect はそのまま残す (fromStagePlan の入力として使う)
```

### `src/pipeline/pipeline.ts`

```typescript
import { Effect } from "effect";
import type { Scope } from "effect";

export function runPipeline(
  stages: readonly EffectStage[],
  input: StageInput,
): Effect.Effect<PriorStageOutputs, unknown, StageRequirements> {
  return Effect.gen(function* () {
    let prior = { ...input.prior };
    for (const stage of stages) {
      yield* Effect.logInfo(`[nas] Running stage: ${stage.name}`);
      const currentInput: StageInput = { ...input, prior };
      const result = yield* stage.run(currentInput);
      prior = mergeEffectOutputs(prior, result);
    }
    return prior;
  });
}

function mergeEffectOutputs(
  prior: PriorStageOutputs,
  result: EffectStageResult,
): PriorStageOutputs {
  const { dockerArgs, envVars, _dockerArgsReplacement, ...rest } = result;
  const base = _dockerArgsReplacement ?? prior.dockerArgs;
  return {
    ...prior,
    ...rest,
    dockerArgs: dockerArgs ? [...base, ...dockerArgs] : base,
    envVars: envVars ? { ...prior.envVars, ...envVars } : prior.envVars,
  };
}

/**
 * 既存 StagePlan を EffectStageResult を返す Effect に変換する shim。
 *
 * 各 ResourceEffect を Effect.acquireRelease で実行し、失敗時の rollback と
 * teardown 時の逆順 close を Scope に委譲する。これにより旧 executePlan /
 * teardownHandles のロジックは Scope 管理に置き換わる。
 */
export function fromStagePlan(
  plan: StagePlan | null,
): Effect.Effect<EffectStageResult, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    if (plan === null) return {};
    for (const effect of plan.effects) {
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => executeEffect(effect),
          catch: (e) => e,
        }),
        (handle) => Effect.promise(() => handle.close().catch(() => {})),
      );
    }
    const { dockerArgs: replacement, ...restOverrides } = plan.outputOverrides;
    return {
      ...restOverrides,
      dockerArgs: plan.dockerArgs,
      envVars: plan.envVars,
      _dockerArgsReplacement: replacement,
    };
  });
}
```

### `src/stages/worktree/prompt_service.ts` (新規)

```typescript
import { Context, Effect, Layer } from "effect";
import type { WorktreeEntry } from "./management.ts";
import type {
  BranchAction,
  DirtyWorktreeAction,
  WorktreeAction,
} from "./prompts.ts";
import * as prompts from "./prompts.ts";

export class PromptService extends Context.Tag("nas/PromptService")<
  PromptService,
  {
    readonly worktreeAction: (path: string) => Effect.Effect<WorktreeAction>;
    readonly dirtyWorktreeAction: (
      path: string,
    ) => Effect.Effect<DirtyWorktreeAction | null>;
    readonly branchAction: (
      branch: string | null,
      base: string | null,
      repoRoot: string | null,
    ) => Effect.Effect<BranchAction>;
    readonly reuseWorktree: (
      entries: readonly WorktreeEntry[],
    ) => Effect.Effect<WorktreeEntry | null>;
    readonly renameBranchPrompt: (
      current: string,
    ) => Effect.Effect<string | null>;
  }
>() {}

export const PromptServiceLive = Layer.succeed(PromptService, {
  worktreeAction: (p) => Effect.promise(() => prompts.promptWorktreeAction(p)),
  dirtyWorktreeAction: (p) =>
    Effect.promise(() => prompts.promptDirtyWorktreeAction(p)),
  branchAction: (b, base, root) =>
    Effect.promise(() => prompts.promptBranchAction(b, base, root)),
  reuseWorktree: (entries) =>
    Effect.sync(() => prompts.promptReuseWorktree([...entries])),
  renameBranchPrompt: (current) =>
    Effect.sync(() => {
      const v = prompt(`[nas] New branch name (current: ${current}):`)?.trim();
      return v && v.length > 0 ? v : null;
    }),
});

/** テスト用 Layer: 決定的な応答を返す fake. */
export const makePromptServiceFake = (
  responses: Partial<Context.Tag.Service<PromptService>>,
) => Layer.succeed(PromptService, { /* defaults + overrides */ });
```

既存の `prompts.ts` の内部実装 (stdin 直叩きループ) には手を入れず、Layer が
薄くラップするだけ。

### `src/stages/worktree/stage.ts`

`class WorktreeStage implements ProceduralStage` を全廃し、以下のような plain
object の `EffectStage` に書き換える:

```typescript
import { Effect } from "effect";
import type { EffectStage } from "../../pipeline/types.ts";
import { PromptService } from "./prompt_service.ts";

interface WorktreeState {
  readonly worktreePath: string;
  readonly repoRoot: string;
  readonly branchName: string | null;
  readonly baseBranch: string | null;
}

export const WorktreeStage: EffectStage = {
  kind: "effect",
  name: "WorktreeStage",
  run: (input) =>
    Effect.gen(function* () {
      const wt = input.profile.worktree;
      if (!wt) {
        yield* Effect.logInfo("[nas] Worktree: skipped (not configured)");
        return {};
      }

      const prompts = yield* PromptService;

      const repoRoot = yield* Effect.tryPromise({
        try: () => getGitRoot(input.prior.workDir),
        catch: (e) => e as Error,
      });
      const resolvedBase = yield* Effect.tryPromise({
        try: () => resolveBase(repoRoot, wt.base),
        catch: (e) => e as Error,
      });
      yield* Effect.tryPromise({
        try: () => validateBaseBranch(repoRoot, resolvedBase),
        catch: (e) => e as Error,
      });

      // Reuse 分岐
      const existing = yield* Effect.tryPromise({
        try: () => findProfileWorktrees(repoRoot, input.profileName),
        catch: (e) => e as Error,
      });
      if (existing.length > 0) {
        const reused = yield* prompts.reuseWorktree(existing);
        if (reused) {
          yield* Effect.logInfo(`[nas] Reusing worktree: ${reused.path}`);
          const state: WorktreeState = {
            worktreePath: reused.path,
            repoRoot,
            branchName: reused.branch?.replace("refs/heads/", "") ?? null,
            baseBranch: resolvedBase,
          };
          yield* Effect.addFinalizer(() => teardownWorktree(state));
          return { workDir: reused.path, mountDir: repoRoot };
        }
      }

      // 新規 create — Effect.gen で逐次記述、
      // 成功時に Scope.addFinalizer で teardown 登録
      // ...
    }),
};

function teardownWorktree(
  state: WorktreeState,
): Effect.Effect<void, never, PromptService> {
  return Effect.gen(function* () {
    // prompt → 分岐 → git 操作を Effect.gen で素直に記述。
    // 個別の git 操作エラーは Effect.catchAll でログ出しして続行。
    // renameBranch / cherryPickToBase も同様に Effect 化する。
  });
}
```

### 既存 PlanStage 8 個のラップ

例 (`src/stages/mount.ts`):

```typescript
// Before
export function createMountStage(mountProbes: MountProbes): PlanStage {
  return {
    kind: "plan",
    name: "MountStage",
    plan: (input) => planMount(input, mountProbes),
  };
}

// After
export function createMountStage(mountProbes: MountProbes): EffectStage {
  return {
    kind: "effect",
    name: "MountStage",
    run: (input) => fromStagePlan(planMount(input, mountProbes)),
  };
}
```

同じパターンを以下の 8 ファイルに適用する。`planMount` 等の純粋 planner 関数
自体には一切触らない。

- `src/stages/mount.ts`
- `src/stages/dind.ts`
- `src/stages/docker_build.ts`
- `src/stages/hostexec.ts`
- `src/stages/launch.ts`
- `src/stages/nix_detect.ts`
- `src/stages/proxy.ts`
- `src/stages/dbus_proxy.ts`

### `src/cli.ts`

```typescript
import { Effect } from "effect";
import { PromptServiceLive } from "./stages/worktree/prompt_service.ts";

// ...
await Effect.runPromise(
  runPipeline(stages, {
    config,
    profile: effectiveProfile,
    profileName: name,
    sessionId,
    host: hostEnv,
    probes,
    prior: initialPrior,
  }).pipe(
    Effect.scoped,
    Effect.provide(PromptServiceLive),
  ),
);
```

`new WorktreeStage()` → `WorktreeStage` (plain object) に変更。

## テスト方針

### `src/pipeline/pipeline_test.ts`

- `runPipeline` が Effect を返すため、各テストは
  `await Effect.runPromise(Effect.scoped(runPipeline(...)))` で実行する。
- `ProceduralStage` 用テストは `EffectStage` 用に書き換え。
- teardown 順序テストは `Effect.addFinalizer` で finalizer を登録する
  EffectStage を使って書き換え。

### `src/pipeline/types_test.ts`

- `ProceduralStage` / `ProceduralResult` 関連の型テストを削除。
- `EffectStage` / `EffectStageResult` / `PromptService` 型テストを追加。

### 既存の個別 stage test (`mount_test.ts` など)

- 着手前に `stage.plan(input)` 直接呼び出しの件数を grep で調査する。
- 多くは `planMount(input, probes)` のような pure 関数を直接呼んでいると想定。
  その場合は変更不要。
- `stage.plan(...)` を経由しているものは、pure planner 関数を直接呼ぶ形に
  書き換える (stage object ではなく実装関数を import)。

### WorktreeStage の新規テスト

新規 `src/stages/worktree/stage_test.ts` を追加する。`PromptServiceFake` Layer
で決定的な応答を流し込み、`runPipeline` 経由で結果を検証する。

### `src/cli_test.ts`

Effect 起動経路に合わせて必要なら更新。

## skill ドキュメント改訂

`skills/effect-separation/SKILL.md` を全面改訂:

- Stage 種別は `EffectStage` のみ。
- 副作用は `Effect.tryPromise` / `Effect.promise` / `Scope.addFinalizer` で記述。
- 純粋計算は Effect 外の通常関数として残してよい (`planMount`,
  `buildDockerArgs` など)。
- Service は `Context.Tag` + `Layer` で注入 (例: `PromptService`)。
- 既存 `StagePlan` DSL は legacy shim (`fromStagePlan`) 経由で使えるが、
  新規 stage は `Effect.gen` で直接書くことを推奨。
- module-level const / let / 副作用の禁止ルールは維持。

## 影響ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `package.json` / `bun.lock` | `effect` を追加 |
| `src/pipeline/types.ts` | PlanStage / ProceduralStage 削除、EffectStage / EffectStageResult / StageRequirements 追加 |
| `src/pipeline/pipeline.ts` | runPipeline を Effect 化、fromStagePlan shim 追加、teardowns 配列管理を削除 |
| `src/pipeline/pipeline_test.ts` | テスト全面書き直し (Effect 実行経路) |
| `src/pipeline/types_test.ts` | ProceduralStage 型テスト削除、EffectStage 型テスト追加 |
| `src/stages/worktree/prompt_service.ts` | **新規** PromptService Context + Layer |
| `src/stages/worktree/stage.ts` | Effect.gen で完全書き直し |
| `src/stages/worktree/stage_test.ts` | **新規** PromptServiceFake を使った unit test |
| `src/stages/mount.ts` | EffectStage 返却に変更 (fromStagePlan 経由) |
| `src/stages/dind.ts` | 同上 |
| `src/stages/docker_build.ts` | 同上 |
| `src/stages/hostexec.ts` | 同上 |
| `src/stages/launch.ts` | 同上 |
| `src/stages/nix_detect.ts` | 同上 |
| `src/stages/proxy.ts` | 同上 |
| `src/stages/dbus_proxy.ts` | 同上 |
| `src/cli.ts` | Effect.runPromise 経路、WorktreeStage 参照修正 |
| 各 stage の `*_test.ts` | 必要に応じて更新 (planner 直接呼び出しに寄せる) |
| `skills/effect-separation/SKILL.md` | 全面改訂 |

## 完了条件 (Definition of Done)

- [ ] `ProceduralStage` / `PlanStage` という型名が完全に消滅している
      (`grep` で 0 件)
- [ ] `runPipeline` が
      `Effect.Effect<PriorStageOutputs, unknown, StageRequirements>` を返す
- [ ] `bunx tsc --noEmit` が通過する
- [ ] `bun test src/` (unit tests) が通過する
- [ ] `bun run compile` が成功し、`effect` 導入前後のバイナリサイズ差分を
      測定・記録する
- [ ] `skills/effect-separation/SKILL.md` が新アーキテクチャを反映している
- [ ] `WorktreeStage` の新規 unit test が追加されている

## 注意点 / 既知のリスク

- **`bun build --compile` のバンドルサイズ増加**: Effect.ts は tree-shake が
  効くが、実測値は未確認。DoD で測定する。増加が許容できない場合は方針再考。
- **`PromptService` の R 型伝播**: `StageRequirements = Scope.Scope |
  PromptService` の union を採用する。PromptService を使わない stage は
  superset の型を受け入れるだけ。将来 DockerService などを足す場合は
  `StageRequirements` に追加していく。
- **エラーチャンネル**: 本プランでは `unknown` で開始する。将来 `Data.TaggedError`
  に段階的に狭めていく余地を残す。
- **既存 `*_integration_test.ts`**: Docker 前提で本プランの範囲外。unit tests
  のみを DoD の対象とする。
- **`WorktreeStage` teardown の prompt 失敗時挙動**: 現行実装は各 git 操作を
  try/catch で囲んでログ出しのみ、という緩い保証になっている。Effect 化する
  際は `Effect.catchAll` で同じ振る舞いを維持する。teardown 中の例外は Scope
  レベルで握りつぶさないと pipeline 全体の失敗扱いになるので注意。
