# Pipeline refactor design

## Problem

現在の pipeline stage は `StageInput.prior: PriorStageOutputs` という flat な shared bag 経由で通信している。このバッグには以下が混在する:

- ドメイン状態 (`workDir`, `nixEnabled`, `networkName` など)
- 低レベルの launch 表現 (`dockerArgs`, `envVars`, `agentCommand`)
- `string | undefined` で表現された optional capability state

この構造は stage の依存を暗黙化し、change amplification を増やし、中間 stage に Docker CLI 片の操作を強いる。

## Proposed architecture

### 1. Shared state をドメイン slice に分割

`PipelineState` を slice-based に再構成する:

```ts
interface PipelineState {
  workspace: WorkspaceState;
  session: SessionState;
  nix: NixState;
  dbus: DbusState;
  hostexec: HostExecState;
  dind: DindState;
  network: NetworkState;
  prompt: PromptState;
  proxy: ProxyState;
  container: ContainerPlan;
}
```

原則:

- slice はドメインの意図を表す。Docker CLI encoding は持たない
- `dockerArgs` は中間状態から消える
- `envVars` は中間状態から消え、構造化された env / container plan data に置き換わる
- `LaunchStage` が `ContainerPlan -> LaunchOpts` を compile する唯一の場所になる

Slice 設計の注意点:

- `network` / `prompt` / `proxy` は一枚岩にしない。ランタイム識別 (network name)、プロンプトトークン、ブローカー/エンドポイントはそれぞれ別関心で、書き込む stage も異なる。
- `dbus` は `{ enabled: false } | { enabled: true; runtimeDir; socket; sourceAddress }` の discriminated union で、`enabled: true` なのに path が無い invalid state を型で排除する。
- `container` slice は `ContainerPlan` (§3 参照) そのもの。

### 2. Reader-style state requirements

Stage は必要な slice を `Needs` として宣言し、Effect で副作用と service 要件を表す。以下のシグネチャを採用する:

```ts
interface Stage<
  Needs extends SliceKey,
  Adds extends Partial<PipelineState>,
  R = never,
  E = never,
> {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly run: (input: Pick<PipelineState, Needs>) => Effect.Effect<Adds, E, R | Scope.Scope>;
}
```

重要な点:

- `run` は thunk (関数) にする。bare `Effect.Effect<...>` 値だと prior state を service 経由で注入する必要があり `Pick<PipelineState, Needs>` の静的保証が死ぬ。thunk なら `run({ workspace })` で自然に読める。
- state は read-only。`Ref` などの mutable shared state service は導入しない。
- stage の出力は explicit (`Adds`)。
- `R` で effect requirements、`E` で error channel を分離しつつ、両方を `PipelineBuilder` が class-level で union 累積する。

### 3. ContainerPlan と declarative patch

`Partial<PipelineState>` は「この slice を populate する」には十分だが、非自明な合成には patch 代数が必要。2 レベルに分ける:

1. **stage-level transition** — stage の入出力を型で追う (builder が slice availability を tracking)
2. **slice-local patch algebra** — slice 内の合成意味論 (mount を追加 / env を merge / network を置換)

`ContainerPlan` の shape (確定):

```ts
interface ContainerPlan {
  image: string;
  workDir: string;
  mounts: readonly MountSpec[];
  env: EnvPlan;
  network?: NetworkAttachment;
  extraRunArgs: readonly string[];
  command: CommandSpec;
  labels: Record<string, string>;
}

interface MountSpec {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

interface EnvPlan {
  static: Record<string, string>;
  dynamicOps: readonly DynamicEnvOp[];
}

interface DynamicEnvOp {
  readonly mode: "prefix" | "suffix";
  readonly key: string;
  readonly value: string;
  readonly separator: string;
}

interface NetworkAttachment {
  readonly name: string;
  readonly alias?: string;
}

interface CommandSpec {
  readonly agentCommand: readonly string[];
  readonly extraArgs: readonly string[];
}
```

`MountSpec` に `kind: "bind" | "volume"` は**入れない**。現 production は bind のみで、`kind` があると encoder の silent fallback bug (volume == bind) を生む。named volume が必要になったら型とエンコーダを揃えて再導入する。`readOnly` は TS キーワードとの紛らわしさを避けるため camelCase。

`mergeContainerPlan(base, patch: ContainerPatch): ContainerPlan` の merge セマンティクス:

- `mounts`, `dynamicOps`, `extraRunArgs` → append
- `static env`, `labels` → key-merge (patch wins)
- `network`, `command` → replace

複雑な型レベル `Patch<In, Out>` 代数は不要。`Partial`-like な `ContainerPatch` + 手書きの merge 関数で足りる。

### 4. Typed pipeline builder

Stage 配列を生で組む (`[...] as const`) のではなく、現時点で利用可能な slice を追跡する builder を使う:

- `builder.add(mountStage)` は `workspace` がまだ無い段階では compile error
- `builder.add(proxyStage)` は `container` がまだ無い段階では compile error
- `proxyStage` 適用後に `networkConsumerStage` が valid になる

実装は `MissingMarker<Current, Needs>` intersection trick で行う:

```ts
class PipelineBuilder<Initial, Current, RAcc = never, EAcc = never> {
  add<Needs, Adds, R, E>(
    stage: Stage<Needs, Adds, R, E> & MissingMarker<Current, Needs>
  ): PipelineBuilder<Initial, MergeState<Current, Adds>, RAcc | R, EAcc | E>;

  run(initial: Initial): Effect.Effect<Current, EAcc, RAcc | Scope.Scope>;
}
```

`add` 内部では `ErasedStage` にキャストするが、class-level の `RAcc`/`EAcc` tracking が生きているので `run` で正しい型を re-surface できる。

### 5. Runtime execution をシンプルに保つ

1. builder が stage 順序を compile 時 validate
2. runner は具体的な `PipelineState` を保持
3. 各 stage は projected slice を read
4. runner は返された patch / transition を apply
5. 最終 launch stage が Docker CLI に compile

ランタイムループに動的な type-level cleverness は持ち込まない。

## Module boundaries

Effect-separation rule:

- `src/pipeline/` は `src/stages/` や `src/services/` に **value** 依存してはいけない (type-only import は可)
- `encodeDynamicEnvOps` など複数 stage が共有するエンコーダは `src/pipeline/env_ops.ts` に置く (現状は `src/stages/mount.ts` に閉じているので relocation が必要)
- `LaunchOpts` は `src/services/container_launch.ts` が定義。pipeline 側は type-only import で参照する

## Implement-with-review execution rules

- 実装は `implement-with-review` 前提で進め、**planner / plan-reviewer / code-reviewer の全 review task は `GPT-5.4` を使う**。review 品質が悪い場合に planner も `GPT-5.4` へ切り替える、という fallback は **今回から常時適用** とする。
- `## Review Log` は plan review / code review の**直後に毎回追記**する。reject でも approve-with-findings でも、その場で findings・対処・反映コミットを残す。
- 各コミットは review で完結に読める粒度を守り、依存コミットと必須テストを plan に明記する。`test-coverage` warning は差し戻し条件なので、各コミットで対象テストを具体名で書く。

## Migration strategy (commit-by-commit)

### C1. `refactor(pipeline): add state slices and typed builder scaffold`

- **scope**: `src/pipeline/state.ts`, `src/pipeline/stage_builder.ts`, `src/pipeline/types.ts`, `src/pipeline/types_test.ts`, `src/pipeline/pipeline_test.ts`
- **内容**:
  - `PipelineState` / slice key / merge helper の土台を追加
  - typed `PipelineBuilder` の scaffold を追加するが、既存 `runPipelineEffect()` / CLI wiring はまだ変えない
  - `PriorStageOutputs` ベースの現行実装と並走できる型レイヤーだけを入れる
- **依存**: なし
- **テスト期待値**:
  - `bun test src/pipeline/types_test.ts src/pipeline/pipeline_test.ts`
  - `bun run check`

### C2. `refactor(pipeline): introduce container plan compiler`

- **scope**: `src/pipeline/container_plan.ts` (new), `src/pipeline/env_ops.ts` (new), `src/stages/mount.ts`, `src/stages/launch.ts`, 追加テスト
- **内容**:
  - `ContainerPlan` / `ContainerPatch` / `mergeContainerPlan()` / `compileLaunchOpts()` を pure helper として追加
  - `encodeDynamicEnvOps` を `src/pipeline/env_ops.ts` へ移す
  - launch はまだ `StageInput.prior` 駆動のままにし、pure parity helper のみ追加して現行挙動を固定する
- **依存**: C1
- **テスト期待値**:
  - 新規 parity test: baseline mount / dynamic env op / mounts+env+network 混合
  - `bun test src/stages/mount_test.ts src/stages/launch_test.ts src/pipeline/pipeline_test.ts`
  - `bun run check`

### C3. `refactor(stages): dual-write workspace nix and dbus slices`

- **scope**: `src/stages/worktree/stage.ts`, `src/stages/nix_detect.ts`, `src/stages/dbus_proxy.ts`, `src/pipeline/state.ts`, 関連テスト
- **内容**:
  - `worktree`, `nix_detect`, `dbus_proxy` を `PriorStageOutputs` と `PipelineState` の dual-write にする
  - `workspace` / `nix` / `dbus` slice の供給元を確立する
  - `DbusState` discriminated union をここで実運用に乗せる
- **依存**: C1
- **テスト期待値**:
  - `bun test src/stages/worktree_integration_test.ts src/stages/nix_detect_test.ts src/stages/dbus_proxy_test.ts src/stages/dbus_proxy_integration_test.ts`
  - `bun run check`

### C4. `refactor(stages): move session store to session/workspace slices`

- **scope**: `src/stages/session_store.ts`, `src/stages/session_store_test.ts`, `src/pipeline/state.ts`
- **内容**:
  - `SessionStoreStage` の `input.prior.workDir` / `input.prior.dockerArgs` / `input.prior.envVars` 依存を除去
  - `session` / `workspace` slice を読む形に移行し、legacy bag へは必要最小限の互換出力だけ残す
  - review 指摘どおり、これを独立コミットにして `SessionStoreStage` 移行を見える化する
- **依存**: C1, C3
- **テスト期待値**:
  - `bun test src/stages/session_store_test.ts src/pipeline/pipeline_test.ts`
  - 必要なら session metadata 用の追加 unit test
  - `bun run check`

### C5. `refactor(stages): move docker build and rebuild path to slices`

- **scope**: `src/stages/docker_build.ts`, `src/stages/docker_build_test.ts`, `src/cli/rebuild.ts`, 必要なら `src/cli/rebuild_test.ts` (new)
- **内容**:
  - `DockerBuildStage` の `input.prior.imageName` 依存を `workspace/container` 系 slice 参照へ移す
  - `nas rebuild` 側の最小初期 state も `PipelineState` ベースに揃える
  - review 指摘どおり、`DockerBuildStage` を独立コミットで移行する
- **依存**: C1, C2
- **テスト期待値**:
  - `bun test src/stages/docker_build_test.ts`
  - `bun test src/cli_test.ts src/cli/rebuild_test.ts`（`rebuild_test.ts` を追加した場合は必須）
  - `bun run check`

### C6. `refactor(stages): dual-write dind into container/network slices`

- **scope**: `src/stages/dind.ts`, `src/stages/dind_test.ts`, `src/stages/dind_integration_test.ts`, `src/pipeline/state.ts`
- **内容**:
  - `DindStage` を `container` / `network` / `dind` slice dual-write に移行
  - sidecar 起動・teardown は現状維持しつつ、`dockerArgs` / `envVars` 合成を `ContainerPatch` に寄せる
- **依存**: C2, C3
- **テスト期待値**:
  - `bun test src/stages/dind_test.ts src/stages/dind_integration_test.ts`
  - `bun run check`

### C7. `refactor(stages): migrate mount stage to container patch`

- **scope**: `src/stages/mount.ts`, `src/stages/mount_probes.ts`, `src/stages/mount_test.ts`, `src/stages/mount_integration_test.ts`
- **内容**:
  - `MountStage` を `workspace` / `nix` / `container` slice 読み取り + `ContainerPatch` 出力に切り替える
  - `dockerArgs` / `envVars` の直接 merge をやめ、mount/env/workdir を declarative plan に落とす
- **依存**: C2, C3, C6
- **テスト期待値**:
  - `bun test src/stages/mount_test.ts src/stages/mount_integration_test.ts`
  - `bun run check`

### C8. `refactor(stages): migrate hostexec stage to structured state`

- **scope**: `src/stages/hostexec.ts`, `src/stages/hostexec_test.ts`, `src/services/hostexec_broker.ts`, `src/services/hostexec_setup.ts`
- **内容**:
  - `HostExecStage` の `prior.workDir` / `prior.mountDir` / `prior.dockerArgs` / `prior.envVars` 読み取りを `workspace` / `hostexec` / `container` slice に置換
  - broker spec は維持し、container 変更だけ `ContainerPatch` へ寄せる
- **依存**: C2, C3, C7
- **テスト期待値**:
  - `bun test src/stages/hostexec_test.ts`
  - `bun run check`

### C9. `refactor(stages): migrate proxy stage to prompt/proxy/container slices`

- **scope**: `src/stages/proxy.ts`, `src/stages/proxy_test.ts`, `src/services/auth_router.ts`, `src/services/session_broker.ts`, `src/services/envoy.ts`
- **内容**:
  - `ProxyStage` の `networkPromptToken`, `envVars`, `dockerArgs`, network metadata 参照を `prompt` / `proxy` / `network` / `container` slice へ移す
  - `replaceNetwork()` 相当は container/network merge semantics の境界に押し込む
- **依存**: C2, C3, C6, C7
- **テスト期待値**:
  - `bun test src/stages/proxy_test.ts src/stages/dbus_proxy_integration_test.ts`
  - proxy/session-broker/envoy 経路に必要な追加 unit test
  - `bun run check`

### C10. `refactor(stages): switch launch stage to compile from container plan`

- **scope**: `src/stages/launch.ts`, `src/stages/launch_test.ts`, `src/stages/launch_integration_test.ts`, `src/services/container_launch.ts`
- **内容**:
  - `LaunchStage` を `ContainerPlan -> LaunchOpts` の唯一の compiler にする
  - `prior.dockerArgs` / `prior.envVars` / `prior.agentCommand` / `prior.imageName` 依存を除去
  - parity test を verbatim 比較に切り替える
- **依存**: C2, C6, C7, C8, C9
- **テスト期待値**:
  - `bun test src/stages/launch_test.ts src/stages/launch_integration_test.ts`
  - `bun run check`

### C11. `refactor(pipeline): add PipelineState runner and builder execution path`

- **scope**: `src/pipeline/pipeline.ts`, `src/pipeline/stage_builder.ts`, `src/pipeline/pipeline_test.ts`
- **内容**:
  - 旧 `runPipelineEffect()` を温存したまま、`PipelineState` を流す runner / builder 実行経路を追加
  - 旧 bag removal はまだやらず、実行器だけを独立レビュー可能にする
  - 旧 C7 で lump されていた runner/builder 導入をここへ分離する
- **依存**: C1-C10
- **テスト期待値**:
  - `bun test src/pipeline/pipeline_test.ts src/pipeline/types_test.ts`
  - `bun run check`

### C12. `refactor(cli): adopt PipelineState in cli entrypoints`

- **scope**: `src/cli.ts`, `src/cli_test.ts`, `src/cli/rebuild.ts`, 必要な stage factory 呼び出し部
- **内容**:
  - CLI / pipeline runner を `PipelineBuilder` + `PipelineState` 実行経路へ切り替える
  - stage 配列 wiring と初期 state 構築を typed builder に寄せる
  - 旧 C7 で lump されていた CLI adoption をここへ分離する
- **依存**: C5, C11
- **テスト期待値**:
  - `bun test src/cli_test.ts`
  - `bun test src/pipeline/pipeline_test.ts src/stages/launch_integration_test.ts`
  - `bun run check`

### C13. `refactor(pipeline): remove PriorStageOutputs and StageInput.prior`

- **scope**: `src/pipeline/types.ts`, `src/pipeline/pipeline.ts`, 全 stage / 参照テスト / `src/cli.ts`
- **内容**:
  - `PriorStageOutputs` と `StageInput.prior` を削除し、残った互換 shim を撤去
  - 生 stage tuple 組み立てを typed builder に一本化
  - 旧 C7 で lump されていた legacy bag removal を最後の独立コミットに分離する
- **依存**: C12
- **テスト期待値**:
  - `bun test src/ tests/`
  - `bun run check`
  - `bun run lint`

## 既存 `PriorStageOutputs` → 新 slice マッピング

Phase 2 以降の dual-write 実装時の対応表:

| PriorStageOutputs field | 新 slice |
|---|---|
| `workDir`, `mountDir`, `imageName` | `WorkspaceState` |
| `nixEnabled` | `NixState.enabled` |
| `dbusProxyEnabled`, `dbusSession*` | `DbusState` (union) |
| `hostexec*` | `HostExecState` |
| `dindContainerName` | `DindState.containerName` |
| `network*` (identity) | `NetworkState` |
| `networkPrompt*` | `PromptState` |
| `networkBroker*`, `networkProxy*` | `ProxyState` |
| `dockerArgs`, `envVars`, `agentCommand` | `ContainerPlan` (compile 後) |
| `sessionId`, `sessionName` (`StageInput` 由来) | `SessionState` |

## Notes / trade-offs

- Full type-level `Patch<In, Out>` をどこでも使うのは first pass では overkill。実用的には:
  - typed builder が slice availability を tracking
  - slice は merge semantics が意味を持つ場所でだけ patch algebra を使う
- `HasState<X>` を mutable state として導入しない。Reader-only が正解。
- `StageServices` と state requirements は、両方 Effect requirements 経由で provided されるとしても、概念的には分離する。

## PoC findings (2026-04-15)

throwaway で option A/B 比較の型推論検証をした結果:

- `Stage.run` は **thunk 版** (`(input) => Effect.Effect<...>`) を採用。bare Effect 値の場合も `MissingMarker` 型推論と `R` union 伝播自体は壊れないが、prior state 注入を service 経由にせざるを得なくなり `Pick<PipelineState, Needs>` の静的保証が形骸化する。
- `PipelineBuilder` 内部で `add` がスタッフを `ErasedStage` にキャストしても、class-level の `RAcc`/`EAcc` 累積で外側から見た型は保たれる。`NoInfer` などの escape hatch 不要。
- `MountSpec` に `kind` を入れると silent な encoding bug を招くので入れない (§3 参照)。
- `encodeDynamicEnvOps` の relocation は Phase 1 の中で完結させる (Phase 5 まで遅らせない)。pipeline → stages の value 依存はその時点で解消しておく。

## Initial todo candidates

1. C1-C2 で state / builder / container-plan の pure scaffold を確定
2. C3-C6 で low-risk + overlooked stage (`session_store`, `docker_build`, `dind`) を先に移行
3. C7-C10 で `mount` / `hostexec` / `proxy` / `launch` を `ContainerPlan` ベースへ寄せる
4. C11-C13 で runner、CLI adoption、legacy bag removal を別コミットで完了

## Review Log

- 2026-04-15 plan review
  - **finding**: `SessionStoreStage` と `DockerBuildStage` がまだ `input.prior` を読んでいるのに、専用 migration commit が無かった。
  - **countermeasure**: C4 に `SessionStoreStage` 移行、C5 に `DockerBuildStage` + `src/cli/rebuild.ts` 移行を追加。
- 2026-04-15 plan review
  - **finding**: 旧 C7 は runner/CLI adoption/typed builder wiring/legacy bag removal をまとめすぎで review 不可。
  - **countermeasure**: C11 (`PipelineState` runner 追加)、C12 (CLI adoption)、C13 (legacy bag removal) に分割。
- 2026-04-15 plan review
  - **finding**: review task の `GPT-5.4` 利用が計画に operationalize されていなかった。
  - **countermeasure**: `implement-with-review` 実行ルールとして planner / plan-reviewer / code-reviewer の全 review task を `GPT-5.4` 固定、planner fallback も常時 `GPT-5.4` と明記。
- 2026-04-15 plan review
  - **finding**: Review Log の更新タイミングが曖昧だった。
  - **countermeasure**: plan review / code review の直後に findings と対処を毎回追記する運用を明記。
- 2026-04-15 plan review
  - **finding**: commit ごとのテスト計画が粗く、`test-coverage` warning を block できない。
  - **countermeasure**: C1-C13 の各コミットに対象テストファイルと `bun run check` / 最終 `bun run lint` までの必須検証を明記。
- 2026-04-15 C1 code review (round 1)
  - **finding**: `MissingMarker<Current, Needs>` が `keyof Current` を使っていたため、optional プロパティのキーも「利用可能」として扱われていた。`createPipelineBuilder<Partial<PipelineState>>()` の builder に対して `workspace` を要求する stage を `.add()` しても compile error にならない偽陰性があった。
  - **countermeasure**: `RequiredKeys<T>` ヘルパー型（`{} extends Pick<T, K>` で optional を除外）を追加し、`MissingMarker` を `Exclude<Needs & SliceKey, RequiredKeys<Current>>` に変更。optional slice を持つ builder への誤った `.add()` が `never` 引数エラーになることを `@ts-expect-error` 付きの負のテスト（`pipeline_test.ts`）で確認。`bun run check` でディレクティブが消費されることも検証済み。
- 2026-04-15 C2 code review (round 1)
  - **finding**: `encodeDynamicEnvOps()` が `DynamicEnvOp.key` を検証せずに NAS_ENV_OPS へ出力していた。コンテナの entrypoint は `set -euo pipefail` 下で Bash の間接展開を使ってそれらを評価するため、`BAD-NAME` のような不正キーはシェルを abort させる。`MountStage` は呼び出し前にキーを検証していたが、共有ヘルパー/コンパイラ境界に移動した後はその invariant がヘルパー自身によって保護されなくなっていた。
  - **countermeasure**: `env_ops.ts` の `encodeDynamicEnvOps()` 内部に `ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/` による検証を追加し、不正なキーに対して即座に throw するよう修正。`env_ops_test.ts` に dash・先頭数字・空文字・ドット・スペース入りキーの 5 件の regression test を追加。
- 2026-04-15 C3 code review (round 1)
  - **finding**: `DbusProxyStage` の config-disabled 分岐が `{ dbus: { enabled: false } }` しか返さず、他の disabled/fallback 分岐が返す legacy override (`dbusProxyEnabled: false`) と揃っていなかった。merge 後に legacy bag と `dbus` slice が不整合になる余地があった。
  - **countermeasure**: disabled result を `buildDisabledDbusResult()` に集約し、config-disabled 分岐を含む全 disabled/fallback 分岐で `dbusProxyEnabled: false` と `dbus: { enabled: false }` を同じ形で返すよう統一。`dbus_proxy_test.ts` で config-disabled ケースが legacy + slice の両方を返すことを確認。
- 2026-04-15 C3 code review (round 2)
  - **finding**: `buildDisabledDbusResult()` が `dbusProxyEnabled: false` と `dbus: { enabled: false }` しか返さず、legacy の `dbusSessionRuntimeDir` / `dbusSessionSocket` / `dbusSessionSourceAddress` を明示的にクリアしていなかった。partial merge 後に stale な D-Bus session 値が残る余地があった。
  - **countermeasure**: disabled/fallback result に `dbusSessionRuntimeDir: undefined`, `dbusSessionSocket: undefined`, `dbusSessionSourceAddress: undefined` を追加して legacy D-Bus session fields を明示クリアするよう修正。`dbus_proxy_test.ts` に stale な prior の `dbusSession*` を持つ disabled ケースの regression test を追加し、merge 後にすべて `undefined` へクリアされることを確認。
- 2026-04-15 C5 code review (round 1)
  - **finding**: `createDockerBuildStage()` は外部で解決した `BuildProbes` を受け取る一方、`planDockerBuild()` は `prior.workspace.imageName` を優先するため、両者の image 名がズレると別イメージに対する existence/hash probe を誤用する危険があった。
  - **countermeasure**: `BuildProbes` に probe 対象の `imageName` を保持し、`planDockerBuild()` で workspace slice から解決した image 名と一致しない場合は即座に throw する guard を追加。`docker_build_test.ts` に一致ケースの回帰を維持しつつ mismatch 時に guard が発火する regression test を追加。
- 2026-04-15 C6 code review (round 1)
  - **finding**: `DindStage` が structured `network.networkName` と `container.network.name` を DinD network で dual-write していたが、後続の `ProxyStage` は real pipeline で legacy network fields しか上書きしないため、shallow merge 後に structured slices だけが `nas-dind-*` のまま stale になる不整合があった。
  - **countermeasure**: C6 では minimal fix として `DindStage` の structured output を `dind` slice と `container` の non-network fields に限定し、`network` slice をまだ emit しない / `container.network` も scrub するよう変更。legacy `networkName` / `dockerArgs` は現状維持し、proxy/network migration 完了前に stale structured network state が残らないことを `dind_test.ts` / `dind_integration_test.ts` で回帰確認。
- 2026-04-15 C7 code review (round 1)
  - **finding**: `MountStage` の stage result が legacy `dockerArgs` / `envVars` を `input.prior.dockerArgs` / `input.prior.envVars` から再構築しており、`prior.container` にだけ存在する mounts / env / extraRunArgs が legacy 出力から脱落して downstream launch との parity が崩れていた。
  - **countermeasure**: `createMountStage()` で `container` の merged base state から legacy `dockerArgs` / `envVars` を再エンコードする `renderLegacyContainerState()` を追加し、structured base と同じ情報源から legacy 出力も生成するよう修正。`mount_test.ts` に `prior.container` と legacy fields が意図的に不一致な run() regression test を追加し、structured-only mount / env / extraRunArgs が legacy output に保持されることを確認。
- 2026-04-15 C10 code review (round 1)
  - **finding**: `LaunchStage` の legacy fallback が `prior.dockerArgs` をそのまま `extraRunArgs` へ渡していたため、`compileLaunchOpts()` 側で `-w` / network / mounts を再追加して duplicate/conflict を起こし得た。加えて regression test が `prior.container` 経路しか exact-match しておらず、legacy fallback の崩れを検知できなかった。
  - **countermeasure**: `launch.ts` に legacy `dockerArgs` を mounts / workDir / network / extraRunArgs へ正規化する fallback compiler を追加し、`prior.container` 不在時でも structured `ContainerPlan` を経由して旧 launch args と同値になるよう修正。`launch_test.ts` には `-w` + `--network` を含む legacy fallback regression test を追加し、compiled `opts.args` が重複 없이正確に再現されることを確認。
- 2026-04-15 C12 code review (round 1)
  - **finding**: `createCliPipelineBuilder()` の adapter wiring が `createDindStage()` / `createProxyStage()` の `PipelineState` 出力を一部しか surface しておらず、`builder.run()` の戻り state が不完全で typed dependency graph の一部が hidden legacy `priorRef` 側に残っていた。
  - **countermeasure**: CLI-local selector helpers (`pickDindStageSlices`, `pickProxyStageSlices`) を追加し、Dind adapter は `dind` + `container`、Proxy adapter は `network` + `prompt` + `proxy` + `container` をすべて typed builder 側へ返すよう修正。`cli_test.ts` に両 selector の focused regression test を追加し、CLI entrypoint が reviewed C12 scope のまま full `PipelineState` slices を保持することを確認。
- 2026-04-15 C12 code review (round 2)
  - **finding**: C12 round 1 の selector helpers が Dind / Proxy skipped path を考慮しておらず、`createDindStage()` / `createProxyStage()` が `{}` を返す no-op case で missing slice error を投げて CLI の従来 skip 挙動を壊していた。
  - **countermeasure**: selector helpers を no-op aware に修正し、Dind / Proxy とも skip 時は既存 `container` slice をそのまま返し、enabled 時のみ追加 slices を surface するよう変更。`cli_test.ts` に skipped helper regression と、proxy disabled 状態で adapted builder を実行して no-op path が成功する execution test を追加。
- 2026-04-16 C13 code review (round 1, GPT-5.4 requested / gpt-5.3-codex fallback)
  - **finding**: `StageInput` に `prior: Partial<PipelineState>` が残存しており、C13 要件の「`StageInput.prior` 撤去」に反している（`src/pipeline/types.ts`）。
  - **finding**: CLI 側の互換 shim `adaptEffectStageToPipelineStateStage` + `priorRef.current` が残っており、旧実行モデル依存が継続している（`src/cli/pipeline_state.ts`）。
  - **finding**: 旧ランナー `runPipelineEffect` が `StageInput.prior` 前提で残っており、typed builder 単一路線への統一が未完了（`src/pipeline/pipeline.ts`）。
  - **countermeasure**: pending。次ラウンドで C13 完了条件として (1) `StageInput.prior` 削除、(2) CLI adapter shim 撤去と stage 直接接続、(3) `runPipelineEffect` の本番経路撤去とテスト移行、を実施して再レビューする。
- 2026-04-16 C13 replan (round 2)
  - **decision**: C1〜C13 の既存計画番号は維持し、C13 の内部実装を C13-R1.. のサブステップに分割して進める。
  - **C13-R1 対応**:
    - `src/cli_test.ts` から旧 adapter 前提（`adaptEffectStageToPipelineStateStage` / prior 参照）を除去し、`runPipelineState` + typed stage 実行前提へ更新。
    - `src/pipeline/pipeline_test.ts` から `runPipelineEffect` / `StageInput.prior` 前提テストを除去し、typed builder + `runPipelineState` の検証に統一。
    - `src/pipeline/types_test.ts` の型テストを `StageInput`（prior なし）/ `StageResult` / typed `Stage` 前提へ更新し、`src/pipeline/pipeline_test.ts` の `@ts-expect-error` 配置をフォーマッタ後も壊れない位置に整理。
- 2026-04-16 C13-R2 implement
  - **finding**: stage unit/integration テストに `StageInput.prior` / 旧 EffectStage 実行 API 依存が残っており、slice-based typed stage input 前提の C13 完了条件を満たしていなかった。
  - **countermeasure**: `nix_detect_test.ts` / `session_store_test.ts` / `docker_build_test.ts` / `dbus_proxy_test.ts` / `dbus_proxy_integration_test.ts` を更新し、`create*Stage(sharedInput)` + slice-only `run(...)` 呼び出しへ移行。disabled/fallback/merge の期待値は維持して `bun test` と `bunx tsc --noEmit` で対象ファイルを検証。
- 2026-04-16 C13-R2 code review reject (round 1)
  - **finding**: `SessionStoreStage run outputs only the session slice` が `result.session` の部分一致検証に留まっており、`StageResult` 全体に余計な field が混入しても検知できない（F-001）。
  - **countermeasure**: `src/stages/session_store_test.ts` の同テストを `expect(result).toEqual({ session: { sessionId: "sess_xyz" } })` に修正し、出力全体を厳密比較へ変更。あわせて C13-R2 実装ログと検証強度の差分（部分一致だった事実）を本追記で明記（F-002）。
