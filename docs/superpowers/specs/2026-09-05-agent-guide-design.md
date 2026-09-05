# Agent Guide (opt-in) — Design

## 問題

nas のサンドボックスは、内部で動くエージェントにとって「静かに嘘をつく」環境になっている。

- allowlist proxy に拒否されたリクエストは、DNS 解決失敗と区別がつかない形でエージェントに届く。エージェントは「この環境にはネットワークがない」と誤診し、無意味なリトライや、別レジストリへの切り替えといった回避策に走る。実際の正解は「ユーザーにドメイン追加を依頼する」で、エージェント単独では絶対に到達できない。
- hostexec は透過的に動く（wrapper シム + `LD_PRELOAD`）。エージェントから見ると、ごく普通のコマンドが最大 300 秒無応答になる。これはハングではなくホスト側の承認待ちだが、知らなければプロセスを kill して別手段を探す。
- DinD ビルドコンテナには外向き経路がない。base image の pull は通るのに `apt-get` は失敗するという非対称があり、エージェントは Dockerfile を疑い続ける。

いずれも「知っていれば 1 手で正解に行けるが、知らなければ延々と誤った方向に努力する」タイプの知識で、しかも nas を使うすべてのプロジェクトで共通に必要になる。現状これはプロジェクト個別の `CLAUDE.md` に手書きされており（本リポジトリの `CLAUDE.md` にも DinD の項がある）、nas 側から供給されていない。

## ゴール

- nas が、コンテナ内エージェントに向けたガイドを opt-in で供給できる。
- ガイドの内容は、そのセッションの解決済みプロファイルに一致する。無効な機能の話は載せない。
- claude / codex / copilot の 3 エージェントすべてで機能する。
- ホスト側の設定ディレクトリ（`~/.claude` 等）を汚さない。

## 非ゴール

- nas の機能紹介・チュートリアル。**生成されるガイドの本文**は「エージェントが誤診する箇所」だけを扱い、機能の網羅的な説明はしない。それは `docs-site/` の担当領域である。（この機能自体をユーザーに説明する `docs-site/` のページは通常どおり書く。）
- 既定で有効にすること。`enable = false` を既定とする opt-in にとどめる。

## 形式: Agent Skills (SKILL.md)

SKILL.md は Agent Skills のオープン標準であり、nas が対象とする 3 エージェントすべてが対応している。独自形式やエージェント個別の仕組みを使う理由がない。

この標準を選ぶ決定的な利点は **`description` フィールドが常時 system prompt に載る** ことにある。エージェントは skill 本文を読み込む前から、全 skill の名前と 1 行 description をコンテキストに持っている。つまり「`ENOTFOUND` を見た瞬間に、nas のガイドが存在すると気づけるか」という発見タイミングの問題が、追加の常時注入レイヤーなしに解決する。

この性質から、**`description` はガイドの最重要フィールド**である。本文と同じくプロファイル依存で組み立て、有効な機能に対応する症状だけを列挙する。

## 設定

`Profile` に `guide` を追加する。

```pkl
class GuideConfig {
  /// ガイドをコンテナに供給するか。既定は無効（opt-in）。
  enable: Boolean = false

  /// ユーザーが追記する環境固有の注意書き。生成された本文の末尾に置かれる。
  extra: String? = null
}
```

`src/config/Schema.pkl` と、手書きミラーである `src/config/types.ts` の両方を更新する。

`extra` はユーザーが `global.pkl` に書く信頼済みの文字列である。生成内容に対する検証は行わず、そのまま末尾に追記する。

## アーキテクチャ

`src/stages/guide/` に新規ステージを追加する。effect-separation の分離規則に従い、内容生成（純粋）と書き込み（I/O）を分ける。

```
src/stages/guide.ts              # barrel re-export
src/stages/guide/
├── stage.ts                     # createGuideStage / planGuide（純粋）
├── stage_test.ts
├── facts.ts                     # GuideFacts 型 + Profile → GuideFacts（純粋）
├── facts_test.ts
├── content.ts                   # GuideFacts → SKILL.md 文字列（純粋）
├── content_test.ts
├── guide_service.ts             # GuideService: Tag + Live + Fake
└── guide_service_test.ts
```

### データフロー

```
Profile ──(純粋)──> GuideFacts ──(純粋)──> SKILL.md 文字列
                                                │
                                       GuideService.writeGuide()
                                                │
                                     ホスト runtime dir に書き込み
                                                │
                                    ContainerPatch (mounts + command)
```

### GuideFacts

`Profile` から抽出した、ガイド本文の分岐を駆動する事実の集合。**この型はシークレット値を保持できない形にする**（後述のセキュリティ制約）。

```typescript
interface GuideFacts {
  readonly agent: AgentType;
  readonly workDir: string;
  readonly network: {
    /** 未設定時の既定は "deny"。"allow" は存在しない（スコープ単位の Action にのみある）。 */
    readonly fallback: NetworkFallback; // "review" | "deny"
    readonly pendingTimeoutSeconds: number;
    readonly forwardPorts: readonly number[];
  };
  readonly hostexec: { readonly promptEnabled: boolean; readonly timeoutSeconds: number } | null;
  readonly dind: { readonly shared: boolean } | null;
  readonly maskEnabled: boolean;
  readonly displaySandbox: string;
  readonly extra: string | null;
}
```

`hostexec` の事実は `profile.hostexec.prompt` と、各ルールの `approval` フィールドのみから導く。`approval` が必要なのは、承認プロンプトが起きうるのは `approval = "prompt"` のルールが存在するときだけであり、`prompt.enable` だけでは「無反応になりうるか」を判定できないため（ルールに一致しないコマンドは hostexec の対象にならず、`src/hostexec/broker.ts` が `null` を返して素通しする）。

`hostexec.secrets` は読まない。ルールからも `approval` 以外は読まない — とくに `env` と `inheritEnv` はシークレット注入を含みうる。

### 本文のセクションと出現条件

| 条件 | セクション |
|---|---|
| 常時 | workspace 境界（`workDir` の外は書けない / 永続しない） |
| `network.fallback == "review"` | 未許可ドメインへのリクエストは、ホスト側の承認待ちで最大 `pendingTimeoutSeconds` 秒ブロックする。タイムアウトは拒否を意味する |
| `network.fallback == "deny"`（既定） | 未許可ドメインへのリクエストは即座に失敗する。リトライは何度やっても通らない |
| 常時（network 設定がある限り） | エラーは DNS 障害の形で届くが、実体は allowlist 拒否。正解はユーザーにドメイン追加を依頼すること |
| `forwardPorts` が非空 | ホストへ転送されるポートの一覧 |
| `hostexec != null` | 一部コマンドは透過的にホスト側で実行される。承認待ちで最大 N 秒無応答になる。**ハングではないので kill しない** |
| `dind != null` | docker は使えるが、ビルドコンテナに外向き経路がない。base image の pull は通るのに `apt-get` 等は失敗する |
| `maskEnabled` | 出力の一部がマスクされる。見えている値が実物とは限らない |
| `displaySandbox != "none"` | GUI アプリは xpra サンドボックス上で動く |
| `extra != null` | ユーザー追記をそのまま |

`description` も同じ事実から組み立てる。有効な機能に対応する症状だけを列挙し、無効な機能の症状は書かない。

### GuideService

ステージから呼ぶのは 1 つの意図的なメソッドだけにする。

```typescript
interface GuideService {
  /** 生成済み SKILL.md をホスト側 runtime dir に書き出し、クリーンアップ可能なハンドルを返す。 */
  writeGuide(plan: GuidePlan): Effect<GuideHandle, ...>;
}
```

`GuideHandle.close()` でセッション終了時にディレクトリを削除する。ステージは `Effect.acquireRelease` で取得・解放を対にする。書き込み先は `resolveRuntimeSubdir(host, "guide")` 配下のセッション別ディレクトリ。

### マウント配線

エージェントごとに skill の探索パスが異なるため、配線は 3 通りに分岐する。いずれも **ホストから RW bind mount されている設定ディレクトリを避ける**（`~/.claude`、`~/.codex`、`~/.copilot` はホストの実ディレクトリがそのまま見えている）。

| agent | コンテナ内マウント先 | 追加の配線 |
|---|---|---|
| codex | `<containerHome>/.agents/skills/nas-sandbox/` (ro) | なし |
| copilot | `<containerHome>/.agents/skills/nas-sandbox/` (ro) | なし |
| claude | `/opt/nas/guide/.claude/skills/nas-sandbox/` (ro) | `command.extraArgs` に `--add-dir /opt/nas/guide` を追加 |

codex と copilot はどちらも `~/.agents/skills` を読むため共通化できる。nas はホストの `~/.agents` をマウントしていないので、この位置は完全にクリーンである。

Claude Code は `~/.agents/skills` を読まず、`~/.claude/skills` と `.claude/skills`、および `--add-dir` で追加したディレクトリ配下の `.claude/skills` のみを探索する。`~/.claude` はホストから RW マウントされているため使えない。中立な `/opt/nas/guide` に置き、`--add-dir` で拾わせる。

`containerHome` は再計算せず、mount ステージが `container.env.static.NAS_HOME` に置いた値を単一の情報源として読む。ステージの入力型は `StageInput & Pick<PipelineState, "container">` とする。

### パイプライン上の位置

`createMountStage`（`NAS_HOME` を確定させる）より後、`createLaunchStage`（`command.extraArgs` を確定させる）より前に置く。`createHostExecStage` の後に挿入する。

`GuideService` を `pipeline/types.ts` の `StageServices` union に追加する。

## セキュリティ制約

`security-constraints` の C1 / S1 に対する立場を明示する。

**生成されるガイドはコンテナから読める。したがってシークレットの生値を一切含めてはならない。**

これを規約ではなく型で担保する。`GuideFacts` はブール値・列挙値・数値・および `Profile` 由来の非シークレット文字列（`workDir`、`extra`）のみを持ち、`EnvConfig` や `SecretConfig`、`resolveMaskSecrets` の結果を参照しない。`Profile → GuideFacts` の変換関数は `profile.env` と `profile.secrets` を読まない。

環境変数のキー一覧も含めない。コンテナ内で `env` を実行すれば見えるため情報価値がなく、含めれば将来値を混ぜる誘惑を作るだけである。

マウントは read-only とする。エージェントがガイドを書き換えて後続セッションに影響を与える経路を作らない。

## テスト

`test-policy` の分類に従う。

- **unit**: `facts_test.ts`（Profile → GuideFacts の分岐）、`content_test.ts`（各セクションの出現・非出現、`description` の組み立て）、`stage_test.ts`（Fake `GuideService` を使ったマウント配線とエージェント別分岐）。
- **unit（セキュリティ回帰）**: シークレットを含むプロファイルを与えて生成し、出力にシークレット値が現れないことを表明する。C1 を型に加えて実行時にも固定する。
- **integration**: 実際にコンテナを起動し、生成された SKILL.md が想定パスに read-only で存在することを確認する。`imageBuildable` 系の述語に従いサンドボックス内ではスキップする。

## Why — なぜこのアプローチを選んだか

**プロファイルからの生成**を選んだ決め手は、静的な同梱ファイルが積極的に有害になる点にある。`docker.enable = false` のプロファイルに DinD の注意書きを載せれば単に無駄だが、`hostexec = null` のプロファイルに「承認プロンプトで 300 秒ブロックする」と載せるのは誤情報であり、エージェントを実在しない原因の調査に誘導する。さらに `network.fallback` が `review` か `deny` かで、拒否時の挙動が「承認待ちで固まる」と「即エラー」という正反対のものになる。ガイドの価値は正確さに全面的に依存しているので、生成コストを払う価値がある。

**SKILL.md 形式**を選んだのは、`description` が常時 system prompt に載るという性質が、この機能の中心的な課題（エージェントが困った瞬間にガイドの存在に気づけるか）をそのまま解決するため。独自形式ならこの発見レイヤーを自前で作る必要があり、しかも 3 エージェント分作ることになる。

**新規ステージ**として切り出したのは、生成 → 書き込み → マウントという一連の流れが mount ステージの関心事と独立しており、かつ純粋部分（内容生成）の分岐が濃くて独立したテストに値するため。

## Why Not — なぜ他の案を選ばなかったか

- **案 B: nas に固定の SKILL.md を同梱してそのままマウントする** — 実装は最小だが、上記のとおりプロファイルによっては誤情報になる。ガイドが一度でも嘘をつくと、エージェントはガイド全体を信用しなくなり、機能の価値が消える。

- **案 C: 短い常時注入（`--append-system-prompt`）+ 詳細ドキュメントの 2 層構成** — 当初検討したが、skill の `description` が常時コンテキストに載ることを確認した時点で、常時注入レイヤーは skill 機構が最初から提供しているとわかった。2 層にすると同じ役割のものが 2 か所に分散し、エージェントごとに注入フラグの差異（codex / copilot には `--append-system-prompt` 相当がない）を吸収する必要も生じる。

- **案 D: `~/.claude/skills` 等、各エージェントのホームにマウントする** — これらはホストの実ディレクトリが RW で bind mount されている（`src/agents/claude.ts:60`、`codex.ts:53`）。ネストした bind mount を被せてもホスト側に空ディレクトリが残り、ホスト側の Claude Code からは中身のない壊れた skill として見える。`~/.agents` と `/opt/nas/guide` はいずれも nas がマウントしていない位置なので、この副作用がない。

- **案 E: workspace の `.claude/skills` に置く** — ユーザーのリポジトリを汚し、`git status` に出る。論外。

- **案 F: 既定で有効にする** — ガイドは常時コンテキストを消費する（`description` の分だけでも）。nas は個人の設定ファイルで細かく制御される道具であり、供給するかどうかはユーザーが決めるべき。opt-in を既定とする。
