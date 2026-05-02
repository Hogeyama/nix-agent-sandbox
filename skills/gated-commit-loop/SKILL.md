---
name: gated-commit-loop
description: 計画・実装・レビューをサブエージェントで回し、コミット単位で品質を担保するワークフロー
user-invocable: true
argument-hint: "[実装内容の説明]"
---

# Gated Commit Loop

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

1. **review-config を読み込む。** ルールの実体は project-local の `./.gated-commit-loop/review-config.yml`。
   - 既に存在する → そのまま読む
   - 存在しない → SKILL.md と同じディレクトリの `review-config.template.yml` を `./.gated-commit-loop/review-config.yml` にコピーしてから読む（`./.gated-commit-loop/` がなければ作る）
   - **テンプレートを直接編集しない。** 編集対象は常に project-local のコピー。テンプレ更新は project-local に追従させない（既存の調整を上書きしないため）
   - 把握すべき項目:
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
4. **イベントログを初期化する。** Step 5 で `./.gated-commit-loop/<timestamp>-summary.jsonl` に書き出すため、以下を会話内メモに溜めておく。
   - `run_id`（適当なユニーク文字列）、`started_at`、ユーザー依頼の原文
   - 各 plan iteration の verdict と reviewer の理由
   - ユーザーの plan 承認イベント
   - 各 commit の seq / title / hash / review_iters
   - 各 finding の commit_seq / review_iter / rule / severity / file / message
   - finding ごとの `resolution`（後述: 機械的に決まる）

## 実行順序

1. Step 1 を実行し、`./.gated-commit-loop/review-config.yml`（無ければテンプレからコピー）と初期 dirty paths を読み取る。
2. Step 2 の plan loop で、`plan-reviewer` が approve し、かつユーザー承認が会話上で明示されるまで再計画または停止判断を行う。
3. 承認済み計画が得られたら、各 commit を **1件ずつ** Step 3 で処理する。
4. 各 commit では `implementer` → `code-reviewer` → `git-commit` の順で進める。
5. `implementer` が blocked を返したら commit loop を中断し、残件を planner に再計画させて Step 2 に戻る。
6. `code-reviewer` が未通過なら、その findings を implementer に渡して同じ commit をやり直す。
7. 同じ根本原因の reject / review findings が続くか、各ループの上限に達したら、惰性で続けずユーザー判断へ戻す。
8. 全 commit 完了後に Step 4 の完了報告を行い、続けて Step 5 のラベル付け & ログ書き出しを行う。

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

報告が済んだら必ず Step 5 のラベル付け & ログ書き出しに進む。スキップして終わらせない。

## Step 5: ラベル付け & ログ書き出し

このログは `review-config.yml` の rule チューニングに使う一次データ。雑に書き出して終わりにせず、ラベル付けまで通す。

### 1. finding ごとに `resolution` を確定する

イベントログ上の各 finding に、機械的に `resolution` を付ける。

- `fixed` — 同じ commit の **次の review iteration で同等の finding が消えている**（同じ rule + 近接行）
- `ignored` — 最終 review iteration まで残ったが、`stop_when` 通過で commit された（severity が条件未満など）
- `dropped` — その commit が replan で消えたなど、レビュー外の理由で finding が無効になった

### 2. デフォルトラベルを推定する

ユーザー負担を減らすため、以下のヒューリスティックでデフォルト値を埋める。最終確定はユーザーが行う。

- `severity=critical` かつ `resolution=fixed` → `essential`
- `severity=info` かつ `resolution=ignored` → `noise`
- それ以外 → `borderline`

### 3. ユーザーにラベル付けを依頼する

会話上に **finding 一覧テーブル** を提示し、各行のデフォルトラベルとコメント欄を見せて修正してもらう。最低限のカラム:

| # | commit | rule | severity | message (要約) | resolution | default label | label | comment |

依頼の言い回しは「以下のラベルを確認してください。違和感ある行だけ書き換えるか、コメントで補足してください。スキップしてもらってもよいです（その場合 `label: null` として記録します）」のようにする。**ラベル必須にしない**。

コミット単位の評価も同様に短い表で聞く:

| # | commit | hash | rating (`good` / `mixed` / `bad`) | comment |

### 4. 出力先を準備する

1. cwd 直下の `./.gated-commit-loop/` は実行前セットアップで作成済み（`review-config.yml` のコピー先と同じ場所）
2. `./.gated-commit-loop/.gitignore` がなければ作成し、中身は `*` のみ。**review-config.yml と summary.jsonl の両方を git に見せない方針**（チューニングは clone ローカルに閉じる）
3. ファイル名は `<yyyymmddHHMMSS>-summary.jsonl`（ローカルタイムでよい）

### 5. JSONL を書き出す

スキーマは「Appendix: summary.jsonl スキーマ」を参照。1 行 1 イベントで、以下の順で並べる:

1. `meta`（1 件）
2. `plan` / `plan_user`（時系列順）
3. 各 commit について `commit` → 紐づく `finding`(複数)
4. `commit_rating`（commit ごと、ユーザー評価）

ラベル未入力の `finding.label` / `commit_rating.rating` は JSON の `null` として明示的に書く（欠損 ≠ 未確認 を区別したい）。

### 6. 書き出した旨を報告する

`./.gated-commit-loop/<filename>` のパスと、入ったラベル数 / 未ラベル数を 1 行で報告して終了する。

蓄積した summary.jsonl を使って `review-config.yml` を見直したいとユーザーが言ったら、`references/tuning-rules.md` を読んでその手順に従う。

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
- Step 4 の完了報告だけ出して Step 5 のラベル付け & ログ書き出しをスキップする
- ラベル付けをユーザーに頼まず orchestrator が勝手にデフォルトのまま確定させる
- protected dirty paths を巻き込んでコミットする
- `git-commit` skill を使わず、雑な単文メッセージでコミットする

## Appendix: summary.jsonl スキーマ

`./.gated-commit-loop/<yyyymmddHHMMSS>-summary.jsonl` の各行は以下のいずれか。`type` フィールドで判別する。タイムスタンプは ISO 8601。

### `meta` (1 件、先頭)

```json
{
  "type": "meta",
  "run_id": "string",
  "started_at": "2026-05-02T14:30:22+09:00",
  "finished_at": "2026-05-02T15:12:08+09:00",
  "user_request": "ユーザー依頼の原文",
  "review_config_path": ".gated-commit-loop/review-config.yml",
  "max_plan_iterations": 3,
  "max_review_iterations": 3
}
```

### `plan` (各 plan iteration)

```json
{
  "type": "plan",
  "iter": 1,
  "verdict": "approve" | "reject",
  "reviewer_reason": "reject の場合のみ。approve では空文字でよい"
}
```

### `plan_user` (ユーザー判断)

```json
{
  "type": "plan_user",
  "iter": 2,
  "verdict": "approve" | "revise" | "abort",
  "comment": ""
}
```

### `commit` (各コミット)

```json
{
  "type": "commit",
  "seq": 1,
  "title": "feat(x): ...",
  "hash": "abc1234",
  "review_iters": 2,
  "implementer_blocked_count": 0
}
```

### `finding` (review iteration ごとに発生した指摘)

```json
{
  "type": "finding",
  "commit_seq": 1,
  "review_iter": 1,
  "rule": "effect-separation",
  "severity": "critical" | "warning" | "info",
  "file": "src/foo.ts:42",
  "message": "指摘内容（1〜2 文に要約）",
  "resolution": "fixed" | "ignored" | "dropped",
  "label": "essential" | "noise" | "borderline" | null,
  "label_comment": ""
}
```

### `commit_rating` (commit ごとのユーザー評価)

```json
{
  "type": "commit_rating",
  "commit_seq": 1,
  "hash": "abc1234",
  "rating": "good" | "mixed" | "bad" | null,
  "comment": ""
}
```

### 並び順

1. `meta`
2. `plan` / `plan_user` を時系列順
3. 各 commit について `commit` → 紐づく `finding` を `review_iter` 昇順
4. 全 commit ぶん終わったら `commit_rating` を seq 順

集計スクリプト側はこの順序を前提にしてよい（ファイル全体を読んでから集計する場合は順序非依存に処理してもよい）。
