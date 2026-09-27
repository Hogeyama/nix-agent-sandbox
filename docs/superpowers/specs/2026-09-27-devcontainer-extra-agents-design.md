# Dev Container の extraAgents と複数 IDE 拡張

状態: 2026-09-27 レビュー待ち。実装は未着手。

## 目的と利用範囲

`extraAgents` を設定したプロファイルを Dev Container でも使えるようにする。
`agent = "codex"` と `extraAgents { "claude" }` のプロファイルなら、
`nas devcontainer init --profile codex` が成功し、同じコンテナで
Codex と Claude Code の IDE 拡張を利用できる。追加分のホスト CLI も提供し、
Codex から `claude -p` を呼ぶ通常の `extraAgents` の用途も満たす。

読者は、この対応範囲と引数・認証・共有範囲を判断する保守者である。
利用契約、起動経路と状態、認証、再設定、受け入れ条件の順に説明する。
既存の起動・停止手順の詳細は元の Dev Container 設計に委ねる。

ユーザーが確認した IDE 対応範囲は Claude Code と Codex の両方。
Copilot は追加 CLI として提供する。

## 利用契約

- 主エージェントは引き続き Claude または Codex。
  `extraAgents` には主エージェント以外の Claude、Codex、Copilot を指定できる。
  主エージェントとの重複と追加分同士の重複は既存のプロファイル検証で拒否する。
- 主と追加分に含まれる Claude / Codex の VS Code 拡張を両方設定する。
  それぞれの既存 nas ラッパーを指定し、拡張の同梱バイナリを起動する。
- 追加分のホスト CLI バイナリも既存の配置先に read-only で mount する。
  IDE 拡張はこれを使わず、拡張同梱版を使う。
- 追加ホストバイナリが無い場合は CLI が利用不能である旨を警告する。
  Claude / Codex の IDE 拡張は同梱版で利用できるため、セッション全体は拒否しない。
  バイナリの自動インストールはしない。
- `agentArgs` は主エージェント専用。追加 IDE 拡張にも追加 CLI にも渡さない。
  主エージェント用の guide 起動引数と記録設定も、追加分へ転用しない。
  追加分のための新しい引数設定や記録設定は設けない。
- worktree など、今回とは関係しない Dev Container の拒否条件を維持する。

## IDE 設定とバイナリの選択

プロファイルから IDE 対応エージェントの集合を求める純粋な共通処理を作る。
Claude / Codex を固定順で返し、追加分の記載順によって結果を変えない。
設定生成、状態準備、登録との比較はこの同じ集合を使う。

`renderDevcontainerConfig` は、その集合の拡張と設定を合成する。

| エージェント | 拡張 | 設定 |
| --- | --- | --- |
| Claude | `anthropic.claude-code` | `claudeCode.claudeProcessWrapper` に既存の Claude ラッパー |
| Codex | `openai.chatgpt` | `chatgpt.cliExecutable` に既存の Codex ラッパー |

Codex ラッパーは拡張同梱バイナリだけを解決する。ホスト CLI が同じコンテナに
あっても fallback に使わない。Claude ラッパーも拡張から渡された実行ファイルを使う。
拡張と CLI のプロトコルの版を揃える既存の契約を維持する。

## 状態と CLI provision

`ensureDevcontainerAgentState` は IDE 集合に含まれる両方の状態を準備する。
`DevcontainerAgentState` は `claudeState` と `codexState` を同時に持てるものとする。
同じエージェントの IDE 拡張と追加 CLI は、コンテナ内の同じ状態を使う。
主・追加の二つの呼び出しから同一 target を重複 mount しない。

現在の Claude / Codex の provision は、IDE 状態パスを渡すと早期 return し、
ホストバイナリを mount しない。この条件を「状態パスがあるか」と
「ホストバイナリが必要か」に分離する。

- 主エージェントは IDE 用状態を使い、既存どおりホスト CLI の mount を省略する。
- 追加 Claude / Codex は同じ IDE 用状態を使い、ホスト CLI も mount する。
  Codex の既存補助バイナリも通常 CLI と同じ条件で mount する。
- 追加 Copilot は既存の provision を使う。
- 通常の CLI / ACP セッションでのバイナリと状態の扱いは維持する。

state パスは共通 provision 入力へ渡せる形にし、ホストバイナリの要否は明示する。
mount stage は pure planner と既存の stage-facing service を組み合わせる。
状態準備のためのファイル I/O を stage 本体へ追加しない。

## 認証と共有範囲

Codex の IDE と CLI が同じ `~/.codex` を使うため、エージェント単位で認証方式を決める。

| エージェント | Dev Container での既定認証 | 共有と保護 |
| --- | --- | --- |
| Claude（主・追加） | injected | 既存 private root と dummy credentials。明示的 passthrough も既存どおり可能 |
| Codex（主・追加） | passthrough | ホスト `~/.codex` を RW 共有。protectSettings 時は `config.toml` を RO で上乗せ |
| Copilot（追加 CLI） | passthrough | 存在する `~/.copilot` と既存の設定保護 |

Codex が主か追加かにかかわらず、明示的 `injected` は既存の IDE 制約により拒否する。
`agentState.auth = "injected"` の文字列指定も追加 Codex に適用されるため拒否対象。
エラーでは Codex 用の `passthrough` を案内する。
Claude を injected のまま使いたい場合は、Codex だけ Mapping で passthrough にできる。

現在の Dev Container 全体を示す認証 context はこの設計に一致するため維持する。
通常 CLI セッションでは、追加 Codex の既定値も引き続き injected。
mount の dummy ファイル準備と proxy の OAuth source は同じ共通判定を使い、
Claude だけが injected なら Codex の dummy や OAuth source を作らない。

Claude の private root、credential の mount 順序、protectSettings、
状態の保持・破棄は既存契約を維持する。
proxy、HostExec の socket 分離、mask、ネットワーク許可は変更しない。

## 拡張ごとの起動引数

現在は両方のラッパーが同じ `agent-args.sh` の `NAS_AGENT_ARGS` を読む。
そのまま複数拡張を設定すると、たとえば Codex の `-c` が Claude に届き、
主エージェントの guide 引数や記録引数も別の CLI に渡ってしまう。

root 初期化が保存する引数ファイルを、Claude 用と Codex 用に分ける。
Compose の最終計画は主エージェント種別を明示的な静的値として渡し、
capture はその値を検証する。主に対応するファイルへ現在の確定済み引数列を保存し、
もう一方には空の配列を保存する。
各ラッパーは自分のファイルだけを読む。

ファイルは既存と同様に root 所有、0644、原子的更新で作り、
配列要素は `%q` で保存する。空文字、空白、改行、shell metacharacter を保持する。
主エージェントの選択を、ラッパー起動時の環境や呼び出し元が持つ配列から決めない。

Codex の `shell_environment_policy.inherit=all` は wrapper 自身の契約として
主・追加にかかわらず付ける。profile の Codex 引数フィルタは主 Codex にだけ適用する。
環境 capture/apply と PATH 復元は両ラッパーで既存経路を使う。

## 設定変更と既存登録

登録に IDE エージェント集合を追加する。
`up` は主エージェントと IDE 集合を生成時の登録と照合する。
集合に増減があれば、生成済み JSON と実行時の状態が不一致になるため拒否し、
`down` → `init --profile ...` → `up` を案内する。
追加分の順序だけの変更と Copilot CLI だけの増減では、IDE 集合は変わらない。

登録形式の version は既存の 1 を維持し、新フィールドが欠ける登録は
既存の `agent` だけの IDE 集合として読む。`agent` も欠ける旧登録は
既存どおり Claude とみなす。新フィールドが存在する場合は、配列型、対応する
エージェント値、重複がないこと、主エージェントを含むことを検証する。

これにより既存の単独エージェント登録はそのまま使え、追加 IDE を有効にする変更は
明示的な再 init を必要とする。稼働中セッションの init 拒否も維持する。

## init の表示と利用者向け説明

共有表示では、主・追加に含まれる全エージェントの状態と実効認証方式を表示する。
Claude は既存説明を共用し、Codex は IDE の役割にかかわらず直接共有と設定保護を示す。
Copilot は `~/.copilot` が存在する場合の共有を示し、その中に token があるとは説明しない。

追加分については、Claude / Codex は IDE と CLI、Copilot は CLI として使えること、
追加 CLI はホストバイナリを必要とすることを表示する。
Codex 拡張の hook に関する既存表示は、追加 Codex の場合も出す。

プロファイルの併用説明にある「Dev Container は未対応」を更新し、
両拡張の利用、追加 CLI の条件、主専用の agentArgs、IDE 集合変更時の再 init を記す。
認証説明では Dev Container の Codex の例外が追加分にも適用されると明記する。

## 変更境界

| 場所 | 責務 |
| --- | --- |
| `src/domain/devcontainer/` | IDE 集合、profile 検証、設定合成、登録・照合、共有表示 |
| `src/devcontainer/runtime.ts` / `src/stages/mount/mount_probes.ts` | 複数 IDE エージェントの状態準備 |
| `src/agents/{types,registry,claude,codex}.ts` / `src/stages/mount/stage.ts` | 状態とバイナリ選択の分離、追加分への入力 |
| `src/stages/launch/compose_stage.ts` | 主エージェント種別の引き渡し |
| `src/docker/embed/devcontainer-{env,claude,codex}.sh` と必要な entrypoint 接続 | 引数の分離と wrapper ごとの取得 |
| 対応する unit / integration テスト | 状態・認証・起動引数・登録互換の検証 |
| `docs-site/src/content/docs/configuration/{profiles,authentication}.md` | 利用条件と認証の説明 |

## 受け入れ条件と検証

1. 主 Codex + 追加 Claude / Copilot、主 Claude + 追加 Codex / Copilot を受理する。
   主 Copilot、worktree、IDE に含まれる Codex の明示的 injected は拒否する。
   主と追加の重複・追加分同士の重複は既存の profile 検証で拒否する。
2. 両方を含む設定では両拡張と両 wrapper 設定を生成する。
   単独エージェント設定の生成結果は維持する。
3. 両エージェントの状態を準備し、追加分の CLI と必要な補助バイナリを mount する。
   同一 target を重複させず、protectSettings と credential 保護を維持する。
   追加 CLI の欠如は警告し、IDE 利用まで不可能とは表示しない。
4. 主 Codex + 追加 Claude では Claude OAuth source と dummy credentials が揃い、
   主 Claude + 追加 Codex でも Codex は passthrough で dummy / OAuth source を作らない。
   通常 CLI の Codex injected の挙動は回帰テストで確認する。
5. 実際の shell wrapper を fake の同梱実行ファイルに接続し、両方の主従の組み合わせで
   主専用引数が追加分へ漏れないこと、拡張側引数の順序・空要素・引用が保持されること、
   env 適用・終了コードが維持されることを確認する。
   ホスト Codex が存在しても拡張同梱版が選ばれることも確認する。
6. 旧登録、新登録の検証、IDE 集合の増減による up 拒否、順序変更の受理、
   再 init 後の整合性を確認する。
7. Compose への変換まで追加分の mount と RO 属性が保持されることを確認する。
   実 Docker を使う検証は integration レーンで能力判定と cleanup を備える。
8. `fmt`、`lint`、`check`、`docs:build`、`git diff --check` を確認する。
   最後に NAS の `bun run test` とホストの `hostexec bun run test` を順に実行し、
   失敗・skip は環境別に報告する。
   VS Code の両拡張からの実接続は別の確認事項とし、自動試験だけで確認済みとしない。

実装担当はユーザー指定の `claude -p` を使う。
設計と計画の人間レビュー、タスク単位と全体のコードレビューは
`patched-superpowers` に従う。

## なぜこのアプローチを選んだか

ユーザーの目的は、追加エージェントを IDE 拡張からも使うことである。
既存の Claude / Codex の wrapper と状態準備を複数分へ広げれば、
それぞれの拡張同梱 CLI と nas の環境適用を維持できる。
追加分のホスト CLI も提供することで、既存 extraAgents の呼び出し用途も保つ。

状態とバイナリ選択を分けるのは、IDE と CLI が同じ状態を共有しながら、
IDE のプロトコルとホスト CLI の実行経路を別々に成立させるためである。
引数を拡張ごとに分けると、異なる CLI のオプション解釈が混ざらない。
登録への IDE 集合の保存は、設定変更で古い拡張設定が残る不一致を起動前に知らせるためである。

## 他の案を採らない理由

- 一律拒否を外して追加 CLI だけを提供する案は、追加 IDE 拡張を使う要件を満たさない。
- 拡張設定だけを増やす案は、状態の不足と主用引数の混入を残す。
- IDE からホスト CLI を起動する案は、拡張が想定する同梱 CLI との版ずれを招く。
- 同じ Codex に CLI 用 injected と IDE 用 passthrough を併存させる案は、
  HOME と認証状態を別々に管理する必要がある。今回は既存の IDE 認証契約へ統一する。
- 全エージェントへ同じ agentArgs を渡す案は、異なる CLI のフラグを混在させ、
  追加分へは引数を渡さない既存契約にも反する。

## 確認資料

- `AGENTS.md`
- `skills/effect-separation/SKILL.md` と `references/domain-service.md`
- `skills/security-constraints/SKILL.md`
- `skills/test-policy/SKILL.md` と `skills/post-change-checks/SKILL.md`
- `skills/reader-decision-writing/SKILL.md` と `docs-site/AGENTS.md`
- [Dev Container 起動・接続経路の設計](2026-09-15-devcontainer-design.md)
- [Dev Container の Codex 対応設計](2026-09-20-devcontainer-codex-design.md)
- 上記変更境界、および `src/agents/credentials.ts`、
  `src/stages/proxy/stage.ts` の現行実装

過去の設計書の対応範囲には実装後の差分があるため、現在の挙動はコードと照合した。
