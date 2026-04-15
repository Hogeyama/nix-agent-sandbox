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

## Migration strategy

### Phase 0: scaffold types only

- `src/pipeline/state.ts` に slice 定義を追加
- `src/pipeline/stage_builder.ts` に typed builder prototype を追加
- 既存 `runPipelineEffect()` は触らない
- demo や compile 時実験は isolate する

### Phase 1: declarative container plan

- `ContainerPlan`, `MountSpec`, `EnvPlan`, `NetworkAttachment`, `CommandSpec` を定義
- `compileLaunchOpts(plan, meta): LaunchOpts` を実装 (pure)
- `encodeDynamicEnvOps` を `src/pipeline/env_ops.ts` に relocation し、`mount.ts` はそこから import
- legacy `dockerArgs` を parallel で残す
- parity test (`planLaunch(input)` vs `compileLaunchOpts(equivalent plan)`) を整備
  - fixture: (a) baseline workspace mount, (b) dynamic env op case (`encodeDynamicEnvOps` 通過), (c) mounts+env+network 混合
  - arg 比較は flag+value ペアを allowlist でグルーピングして sort 比較 (Docker は独立した `-v`/`-w`/`--network` flag の順序を問わないので verbatim 比較はこの段階では通らない; Phase 4 で launch が単一 emitter になれば verbatim に切り替え可)

これが coupling を最も下げる早期 high-value step。

### Phase 2: 低リスク stage から dual-write

移行しやすい stage から着手:

- `worktree`
- `nix_detect`
- `dbus_proxy`
- `dind`

各 stage は以下の両方を書く:

- legacy `PriorStageOutputs`
- 新 `PipelineState` slice

flag day なしで段階的に rollout できる。

### Phase 3: container-shaping stage を移行

Docker CLI 表現を manipulate している stage:

- `mount`
- `hostexec`
- `proxy`

これらは `dockerArgs` を触るのをやめ、`ContainerPatch` を返すようにする。

### Phase 4: launch を state から compile に切り替え

- `LaunchStage` が `ContainerPlan` を consume
- `prior.dockerArgs` / `prior.envVars` への直接依存を除去
- launch compilation を Docker CLI encoding の唯一の境界にする
- parity test の arg 比較を verbatim に切り替える

### Phase 5: legacy bag を削除

- `PriorStageOutputs` を削除
- `StageInput.prior` を typed state views に置換
- 生 stage tuple 組み立てを typed pipeline builder に置換

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

1. `PipelineState` slice を定義し、低レベル launch field を target model から排除
2. typed pipeline builder prototype を現 runner と parallel で追加
3. `ContainerPlan` と `LaunchOpts` への compiler を導入 + parity test
4. 1-2 個の低リスク stage を移行してモデルを証明
5. launch compilation を新 state model の裏に移し、legacy bag を削除
