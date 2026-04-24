---
name: implement-with-review
description: 計画・実装・レビューをサブエージェントで回し、コミット単位で品質を担保するワークフロー
user-invocable: true
argument-hint: "[実装内容の説明]"
---

# Enterprise Implement-with-Review

計画→計画レビュー→ユーザー承認→実装→コードレビュー→コミットを、**1 コミットずつ明示的に区切って**進めるワークフロー。

この skill の目的は「よさそうに流すこと」ではなく、**状態遷移を壊さずに品質を担保すること**。とくに plan confirmation、replan、review 差し戻し、commit 境界を曖昧にしない。

## 原則

- **orchestrator（あなた）はソースコードを直接読んだり編集したりしない。** 調査・実装・レビューはすべてサブエージェントに委任する。
- **ただし進行管理のための git bookkeeping はしてよい。** `git status --short` / `git diff --name-only` / `git log --oneline` のような、差分境界とコミット記録を扱う操作は orchestrator の責務。
- **実装開始前に、計画をユーザーへ提示し、明示的な承認を得る。** `LGTM` / `go` / `進めて` のような肯定が出るまで Step 3 に進んではいけない。
- **承認は会話上で可視化する。** plan を提示したメッセージと、それに対するユーザー承認が会話履歴で確認できる形にする。内部状態だけ更新して先へ進んではいけない。
- **1 implementer = 1 コミット。** 承認済み計画の 1 commit セクションだけを実装させる。
- **1 commit plan = 1 git commit。** レビュー未通過の差分や無関係な既存 dirty files を混ぜない。
- **同じ根本原因でループが続くときは、惰性で回さずユーザー判断に戻す。** 回数上限に達するまで機械的に回し切ることが目的ではない。

## サブエージェント

| 役割 | 定義ファイル | 役割 |
|------|-------------|------|
| planner | `agents/planner.md` | コードベース調査 + コミット粒度の計画作成 |
| plan-reviewer | `agents/plan-reviewer.md` | 計画の approve / reject 判定 |
| implementer | `agents/implementer.md` | 1コミット分の実装 |
| code-reviewer | `agents/code-reviewer.md` | 1コミット分のコードレビュー |

各定義ファイルに詳細はあるが、**orchestrator は「何を渡せば次の agent が迷わないか」を理解して渡す必要がある。** 「雑にタスク内容だけ渡す」は不可。

## 実行前セットアップ

1. この SKILL.md と同じディレクトリにある `review-config.yml` を読み、以下を把握する。
   - `max_plan_iterations`
   - `max_review_iterations`
   - `stop_when`
   - `rules`
2. 開始時点の `git status --short` を記録し、そこで見えている変更を **protected dirty paths** として扱う。
   - protected dirty paths は、この workflow が作っていない既存変更である可能性が高い
   - 以降の commit には **明示的に対象 scope に含まれると確認できた場合を除き** 入れてはいけない
3. 次の状態をメモして進行管理する。
   - `plan_iteration`
   - `current_plan`
   - `completed_commits`
   - `protected_dirty_paths`
   - `current_commit_review_iteration`

## 実行順序

1. Step 1 を実行し、`review-config.yml` と初期 dirty paths を読み取る。
2. Step 2 の plan loop で、`plan-reviewer` が approve し、かつユーザー承認が会話上で明示されるまで再計画または停止判断を行う。
3. 承認済み計画が得られたら、各 commit を **1件ずつ** Step 3 で処理する。
4. 各 commit では `implementer` → `code-reviewer` → `git-commit` の順で進める。
5. `implementer` が blocked を返したら commit loop を中断し、残件を planner に再計画させて Step 2 に戻る。
6. `code-reviewer` が未通過なら、その findings を implementer に渡して同じ commit をやり直す。
7. 同じ根本原因の reject / review findings が続くか、各ループの上限に達したら、惰性で続けずユーザー判断へ戻す。
8. 全 commit 完了後に Step 4 の完了報告を行う。

## Step 2: Plan Loop

### planner に必ず渡す情報

- ユーザーの元の依頼
- `review-config.yml` の存在と、commit 単位でレビューを通す workflow であること
- 既存の `completed_commits`（再計画時）
- `plan-reviewer` の reject findings（再計画時）
- `implementer` の blocked reason / suggestion（差し戻し再計画時）
- 「各 commit は独立してレビュー・コミット可能な粒度であること」という要求

### plan-reviewer に必ず渡す情報

- ユーザーの元の依頼
- planner が出した計画全文
- 再計画の背景（前回 reject / blocked の要約があれば）

### 判定ルール

1. **plan-reviewer が approve** しただけでは Step 3 に進まない。必ずユーザーに計画を提示し、承認をもらう。
2. ユーザーに提示するときは少なくとも次を含める。
   - commit 一覧
   - 各 commit の scope
   - 主要変更ファイル
   - テスト計画
   - planner が挙げたリスク
3. **ユーザー承認が明示されるまで実装開始禁止。** 承認を受けたら、Step 3 に入る前に orchestrator 自身が短く
   - `Plan approved by user`
   - `Proceeding with Commit 1: <title>`
   のように、どの計画が承認されたかを会話上で再掲してから進む。
4. ユーザーから修正指示が来たら、planner に戻して再計画し、再度 plan-reviewer を通す。
5. **同じ根本原因の reject が 2 回続いたら、上限未満でもユーザーに返す。**
   - 例: 要求が既存アーキテクチャと衝突していて、planner が形を変えても reviewer が同じ趣旨で reject する
   - この場合は「現状の最善計画」「reject 理由」「ユーザーに決めてほしい点」を短く整理して止める
6. `max_plan_iterations` 到達時も同様にユーザー判断へ戻す。新しいユーザー入力なしに惰性で再計画しない。

## Step 3: Commit Loop

承認された計画の各 commit について、以下を **順番どおり** 実行する。

### 1. implementer に渡す情報

- 承認済み計画全文
- 今回実装する commit セクション
- すでに完了した commit 一覧
- protected dirty paths
- 現在が review 差し戻しの再実装なら、その findings 全文
- 「今回の commit scope 外の変更は禁止」

### 2. implementer の戻り値を処理

- **`status: done`** → code-reviewer へ進む
- **`status: blocked`** → planner に残り計画を再計画させ、Step 2 に戻る
  - completed_commits は維持する
  - blocked を無視して orchestrator が勝手に方針変更してはいけない

### 3. code-reviewer に渡す情報

- `review-config.yml` の `rules`
- 今回の commit 計画
- commit 固有の **レビュー観点**
- 「今回レビューすべき差分はこの commit scope の変更だけ」であること

### 4. レビュー判定

各 finding について、そのルールの `stop_when`（未指定ならグローバル `stop_when`）を適用する。

- `no_critical_findings`: critical が 0 件ならそのルールは通過
- `no_findings`: severity に関係なく 1 件でもあればそのルールは未通過

判定結果:

- **全ルール通過** → コミットへ進む
- **未通過ルールあり** → findings を implementer に渡して再実装
- **同じ趣旨の findings が繰り返される / `max_review_iterations` 到達** → ユーザー判断に戻す

### 5. コミットのしかた

レビュー通過後に初めてコミットしてよい。

1. `git status --short` / `git diff --name-only` で、今回 commit に含めるべきファイルを確認する
2. protected dirty paths や他コミットの差分を混ぜない
3. **`git-commit` skill を使う**
   - タイトルは planner が出した conventional commit 案をベースにする
   - 本文には「なぜこの分割にしたか」「レビューで何を潰したか」を含める
   - placeholder っぽい短文（例: `ok`, `wip`, `おｋ`）は禁止
4. コミット後、hash と message を記録して `completed_commits` に追加する

`git-commit` skill が使えない環境なら、その時点で止まり、理由を明示してユーザーへ返す。雑に `git commit -m` して先へ進まない。

## Step 4: 完了報告

全コミット完了後は、少なくとも次を報告する。

- 実行したコミット一覧（hash + message）
- 各コミットのレビュー結果サマリー
- 実行した再計画 / 差し戻しの回数
- 残っている warning / info（あれば）
- 途中でユーザー判断を挟んだ箇所（あれば）

## 実行時テンプレート

### planner 依頼テンプレート

以下を 1 つの依頼に含める:

- ユーザー依頼
- 今回の workflow が commit 単位の implement → review → commit で進むこと
- 再計画なら reject / blocked の内容
- 完了済み commit があれば再利用前提で残件だけ計画すること

### implementer 差し戻しテンプレート

以下を 1 つの依頼に含める:

- 今回対象の commit セクション
- code-reviewer findings 全文
- scope 外変更禁止
- ただし findings 修正で影響する関連分岐は scope 内として整合させてよい

### code-reviewer 依頼テンプレート

以下を 1 つの依頼に含める:

- `review-config.yml` の rules
- 今回の commit 計画
- commit 固有のレビュー観点
- 今回レビュー対象は current commit の差分のみであること

## Red flags

- plan-reviewer approve だけで実装を始める
- ユーザー承認を表示せずに「たぶん OK だったはず」で進める
- 同じ理由の reject を、ユーザー確認なしに回数上限まで機械的に回し続ける
- review 未通過差分をコミットする
- protected dirty paths を巻き込んでコミットする
- `git-commit` skill を使わず、雑な単文メッセージでコミットする
