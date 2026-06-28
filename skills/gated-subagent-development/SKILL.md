# Gated Subagent Development (GSD)

commit 単位でゲートされたサブエージェント駆動開発ワークフロー。
計画は superpowers、commit ごとの実装は fresh subagent + configurable review gate、
全 commit 完了後に `/code-review` で branch 全体をレビューする。

## 原則

- **orchestrator（あなた）の責務は進行管理であり、コード品質の判定とコード本体の編集はしない。** 判断は implementer / code-reviewer に任せ、Edit / Write でコード本体を書かない（`./.gated-subagent-dev/` 配下の bookkeeping は例外）。
- **進行管理に必要な範囲では差分・コードを読んでよい。**
  - bookkeeping: `git status --short` / `git diff --name-only` / `git diff --stat` / `git log --oneline` / `git show --stat <hash>`
  - scope 検証: 各 commit 直前に `git diff --cached` を読み、入る差分が今回の commit scope 通りか／protected dirty paths が混ざっていないかを確認する
  - finding 解釈: code-reviewer が指す `file:line` を Read で開き、同じ趣旨の指摘が iteration を跨いで繰り返されていないかを判定する
- **judgment（判定）と verification（確認）を混ぜない。** 読みの結果から「この実装はこうあるべき」と結論を出しそうになったら、それはサブエージェントの担当。
- **1 implementer = 1 コミット。** 承認済み計画の 1 commit セクションだけを実装させる。
- **1 commit plan = 1 git commit。** レビュー未通過の差分や無関係な既存 dirty files を混ぜない。
- **同じ根本原因でループが続くときは、惰性で回さずユーザー判断に戻す。**
- **Continuous execution:** 実装開始後はタスク間でユーザーに確認を取らない。止まる理由は BLOCKED / 解決不能な曖昧さ / 全タスク完了のみ。

## サブエージェント

| 役割 | 定義ファイル | 概要 |
|------|-------------|------|
| implementer | `agents/implementer.md` | 1 コミット分の実装 |
| code-reviewer | `agents/code-reviewer.md` | 1 コミット分のコードレビュー |

呼び出しは `Agent` ツールに `subagent_type: <name>` を渡す。登録されていない環境では、`agents/<name>.md` を読みその内容をプロンプトとして general-purpose agent を呼ぶ。

## 依存スキル

| スキル | 用途 | 呼び出し方 |
|--------|------|-----------|
| `superpowers:brainstorming` | Phase 0: 要件整理 | Skill ツール |
| `superpowers:writing-plans` | Phase 0: commit 粒度の計画作成 | Skill ツール |
| `superpowers:subagent-driven-development` | file handoff (task-brief, review-package, workspace) | SDD の手順に従う |
| `superpowers:finishing-a-development-branch` | Phase 3: ブランチ完了処理 | Skill ツール |
| `/code-review` | Phase 2: branch 全体の multi-angle review | `/code-review` として呼び出し |

## 全体フロー

```
Phase 0: Plan (superpowers)
│  brainstorming → writing-plans → ユーザー承認
│  成果物: commit 粒度の実装計画ファイル
│
Phase 1: Commit Loop
│  Per Commit:
│    ① implementer dispatch (fresh subagent)
│    ② code-reviewer (review-config rules)
│    ③ gate: pass → commit / fail → fix
│    ④ commit + progress ledger 記録
│  blocked → ユーザー判断
│
Phase 2: Final Review (/code-review)
│  branch diff 全体に multi-angle review
│  findings → fix subagent → 必要なら re-review
│
Phase 3: Wrap-up
│  resolution labeling + summary.jsonl
│  finishing-a-development-branch
```

## Phase 0: Plan

using-superpowers のフローに従う。orchestrator は以下を順に実行する。

1. `superpowers:brainstorming` を Skill ツールで呼び出し、要件を整理する
2. `superpowers:writing-plans` を Skill ツールで呼び出し、commit 粒度の計画を作成する
3. 計画をユーザーに提示し、明示的な承認を得る
   - 少なくとも commit 一覧、各 commit の scope、主要変更ファイル、テスト計画、リスクを含める
   - `LGTM` / `go` / `進めて` のような肯定が出るまで Phase 1 に進んではいけない

### 計画のファイル保存

ユーザー承認後、Phase 1 に入る前に:

1. 承認済み計画を `./.gated-subagent-dev/<run_id>-commit-plan.md` に書き出す
2. ユーザーの依頼に上位計画がある場合、そのパスを記録する（インラインなら `./.gated-subagent-dev/<run_id>-upper-plan.md` に書き出す）

## Phase 1 セットアップ

Phase 1 の最初のコミットに入る前に以下を行う。

### review-config の準備

1. `./.gated-subagent-dev/review-config.yml` が存在するか確認する
   - 存在する → そのまま読む
   - 存在しない → この skill の `review-config.template.yml` を `./.gated-subagent-dev/review-config.yml` にコピーしてから読む
   - **テンプレートを直接編集しない**
2. `./.gated-subagent-dev/.gitignore` がなければ作る。中身は `*` の 1 行のみ

### 状態の初期化

1. `git status --short` で protected dirty paths を記録する
2. 以下を管理状態として保持:
   - `completed_commits`
   - `protected_dirty_paths`
   - `current_commit_review_iteration`
3. イベントログを初期化する（Phase 3 で summary.jsonl に書き出す）
   - code-reviewer の戻り値 (JSON) はそのまま保持する。要約・再構成しない

### Model 選択方針

| タスク種別 | モデル |
|-----------|--------|
| 機械的実装 (1-2 ファイル, 明確 spec) | cheap |
| 統合・判断タスク (複数ファイル連携) | standard |
| 設計判断が必要なタスク | most capable |
| commit レビュー | diff の複雑さに応じて選択 |
| Phase 2 の final review | most capable |

**常に model を明示して dispatch する。** 省略するとセッションの最高コストモデルを継承する。

### Durable Progress

conversation memory は compaction で消える。進捗は ledger ファイルで追跡する。

- skill 開始時に `subagent-driven-development` の手順に従って workspace を初期化し、`progress.md` を確認する。完了済みタスクがあればそこから再開する
- タスク完了時に ledger に 1 行追記する: `Task N: complete (commits <base7>..<head7>, review clean)`
- compaction 後は ledger と `git log` を信頼する

## Phase 1: Commit Loop

承認された計画の各 commit について、以下を順番どおり実行する。

### 1. implementer の dispatch

`subagent-driven-development` の手順に従って task-brief を生成し、implementer に渡す。

implementer に渡す情報:
- 計画ファイルのパス（上位計画があればそのパスも）
- task-brief ファイルのパス
- 今回実装する commit の番号
- すでに完了した commit 一覧
- protected dirty paths
- review 差し戻しの再実装なら、その findings 全文
- report ファイルのパス（implementer がここに詳細を書く）

### 2. implementer の戻り値を処理

- **done** → code-reviewer へ進む
- **blocked** → ユーザーに報告し判断を仰ぐ。orchestrator が勝手に方針変更してはいけない
- **needs_context** → 不足情報を提供して re-dispatch
- **done_with_concerns** → concerns を読み、正当性の懸念なら対処してからレビューへ。観察的な懸念なら記録してレビューへ

### 3. code-reviewer の dispatch

`subagent-driven-development` の手順に従って review-package を生成し、code-reviewer に渡す。

code-reviewer に渡す情報:
- 計画ファイルのパス（上位計画があればそのパスも）
- 今回のレビュー対象の Commit 番号
- review-package ファイルのパス（diff）
- task-brief ファイルのパス
- implementer の report ファイルのパス

### 4. レビュー判定

review-config.yml の各 rule について、その rule の `stop_when`（未指定ならグローバル `stop_when`）を適用する。

- `no_critical_findings`: critical が 0 件ならそのルールは通過
- `no_findings`: severity に関係なく 1 件でもあればそのルールは未通過

判定結果:
- **全ルール通過** → コミットへ進む
- **未通過ルールあり** → findings を implementer に渡して再実装
- **同じ趣旨の findings が繰り返される / `max_review_iterations` 到達** → ユーザー判断に戻す

### 5. コミットのしかた

レビュー通過後に初めてコミットしてよい。

1. `git diff --cached` で stage した内容を確認し、commit scope 通りであること／protected dirty paths が混ざっていないことを verify する
2. コミットメッセージ:
   - タイトル: planner が出した conventional commit 案をベースにする
   - 本文: 変更の要点、scope の意図、レビューで潰した内容（再実装があれば）
   - **過去・未来の他コミットへの参照は書かない**。現在の状態を declarative に書く
3. `git commit` 後、hash と message を `completed_commits` に追加し、progress ledger に記録する

## Phase 2: Final Review

全 commit 完了後、branch diff 全体に対して `/code-review` を実行する。

1. `/code-review` を呼び出す（effort level は状況に応じて指定する）
2. findings があれば fix subagent を dispatch する
   - 1 回の fix で全 findings をまとめて対応する（finding ごとに fixer を分けない）
3. fix 後、必要なら re-review する
4. critical findings が残る場合はユーザー判断に戻す

## Phase 3: Wrap-up

### Step 1: 完了報告

- 実行したコミット一覧（hash + message）
- 差し戻し / 再実装の回数
- ユーザー判断を挟んだ箇所（あれば）

### Step 2: Resolution Labeling

全 finding に `resolution` を確定する:
- `fixed` — 次の review iteration で同等の finding が消えている
- `ignored` — 最終 iteration まで残ったが、`stop_when` 通過で commit された
- `dropped` — replan 等でレビュー外の理由で無効になった

デフォルトラベルを推定する:
- `severity=critical` かつ `resolution=fixed` → `essential`
- `severity=critical` かつ `resolution=ignored` → `config-smell`
- それ以外 → `borderline`

ユーザーに finding 一覧テーブルを提示し、差分確認を依頼する:

| # | commit | rule | severity | message (要約) | resolution | label (推定) | comment |

commit 単位の評価もデフォルト `null` で提示:

| # | commit | hash | rating | comment |

### Step 3: summary.jsonl 書き出し

スキーマは `references/summary-schema.md` に従う。出力先は `./.gated-subagent-dev/<yyyymmddHHMMSS>-summary.jsonl`。

### Step 4: finishing-a-development-branch

`superpowers:finishing-a-development-branch` を Skill ツールで呼び出す。

## Red Flags

- ユーザー承認なしに Phase 1 を開始する
- review 未通過差分をコミットする
- 同じ理由のループをユーザー確認なしに上限まで回し続ける
- Phase 3 の labeling & ログ書き出しをスキップする
- ラベル付けをユーザーに提示せず orchestrator が勝手に確定させる
- protected dirty paths を巻き込んでコミットする
- 他コミットへの過去・未来参照を含むメッセージでコミットする
- orchestrator がコード本体を Edit / Write する
- model を省略して subagent を dispatch する
- 完了済みタスクを再 dispatch する（ledger を確認する）
