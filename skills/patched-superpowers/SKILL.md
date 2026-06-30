---
name: patched-superpowers
description: 開発タスクで using-superpowers の代わりに使う。superpowers ワークフローに、人間レビューゲートとルールベースのコードレビューを組み込む。
user-invocable: true
argument-hint: '[実装内容の説明]'
---

# Patched Superpowers

superpowers のワークフロー（brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch）に、以下の補正を加えて実行する。

## 起動時にやること

1. 前提スキルの確認: `superpowers:brainstorming`、`superpowers:writing-plans`、`superpowers:subagent-driven-development` がスキル一覧に存在するか確認する。存在しないものがあればユーザーに伝えて停止する。また `diffity` CLI が利用可能か `which diffity` で確認する
2. コーディング規約スキルの読み込み: プロジェクトにコーディング規約系スキルがあれば Skill ツールで読む（名前に `guidelines`、`conventions`、`coding`、`test` を含むもの）。読んだ規約は設計判断に反映する。writing-plans では Global Constraints にこれらのスキル名を列挙し、実装者・レビュアーに読ませる指示を明記する。
3. Skill ツールで `superpowers:brainstorming` を呼び出す
4. 以下の補正を Phase ごとに適用する

---

## Phase 1: 設計（brainstorming + writing-plans）

superpowers の brainstorming → writing-plans を実行しつつ、以下の補正を追加する。

### spec と plan の人間レビュー

spec と plan をそれぞれ書き終えたら、次のフェーズに進む前に diffity でユーザーにレビューしてもらう。ユーザーが承認するまで先に進まない。

手順:

1. 設計中に自信のなかった判断や迷った点があればユーザーに伝える。ユーザーがレビューで注目すべき箇所の手がかりになる
2. Skill ツールで `diffity-tour` を読み、spec / plan の変更に対する Review mode のツアーを作成する。ツアーがユーザーのレビューのガイドになる
3. `diffity` を起動してブラウザで diff を開く（例: `diffity HEAD~1`）。ユーザーにレビューを依頼する
4. ユーザーがブラウザでコメントを付けて知らせてきたら、`diffity agent list --status open --json` でコメントを取得する
5. 各コメントに対応する — 修正が必要なら修正し `diffity agent resolve <id> --summary "..."` で解決、質問なら `diffity agent reply <id> --body "..."` で返答
6. open コメントがなくなったらユーザーに承認を求める。ユーザーが追加コメントを付けた場合は 4-5 を繰り返す

### Phase 1 の完了条件

spec と plan の両方でユーザーが承認したこと。

---

## Phase 2: 実装（subagent-driven-development ベース）

superpowers の subagent-driven-development を実行しつつ、以下を変更する。実行方式の選択肢をユーザーに提示せず、subagent-driven-development で直ちに開始する。

### タスクごとのレビューで独自の code-reviewer を使う

superpowers の task-reviewer の代わりに、このスキル同梱の code-reviewer（`code-reviewer-prompt.md`）を使う。

code-reviewer は `./.superpowers/review-config.yml` のルールに基づいてレビューし、JSON で findings を返す。初回実行時に review-config.yml が存在しなければ、このスキルディレクトリの `review-config.template.yml` をコピーする。`./.superpowers/.gitignore` がなければ `*` の1行で作る。

code-reviewer を Agent ツールで起動する際は、`code-reviewer-prompt.md` のプロンプト全文を読み、その内容を prompt に渡す。追加で以下を含める:
- Phase 1 で特定したコーディング規約スキルの名前
- タスクブリーフのパス
- spec ファイルのパス
- diff の範囲（BASE..HEAD）

### レビュー結果の扱い

- `passed: true` → タスク完了
- `passed: false` → critical/warning の findings を検証し、妥当なら修正サブエージェントを起動
- ユーザーの明示的な設計判断と矛盾する finding → progress ledger に `design-decision: <設計判断> → <棄却した finding>` と記録してスキップ。後続タスクで同じ指摘が出たら ledger を参照してスキップ
- Critical finding を「既存パターンだから」という理由だけで棄却しない。棄却にはユーザーの明示的な設計判断が必要

### レビュー修正は1修正1コミット

findings をまとめず、1件ずつ修正して個別にコミットする。後から `git rebase -i` で squash / drop できるようにする。

---

## Phase 3: 全体レビュー

全タスク完了後、`/code-review high` を実行する。タスクスコープでは見えない全体的な問題を検出する。

findings のうち correctness bugs は修正サブエージェントを起動（1修正1コミット）。cleanup 系はユーザーに提示して判断を仰ぐ。

### 全体 diff の人間レビュー

`/code-review` の findings 対応が終わったら、ブランチ全体の diff をユーザーにレビューしてもらう。

1. Skill ツールで `diffity-tour` を読み、ブランチ全体の diff に対する Review mode のツアーを作成する
2. `diffity` でブランチ全体の diff を開く（例: `diffity main..HEAD`）
3. ユーザーにレビューを依頼する
4. ユーザーがコメントを付けて知らせてきたら、`diffity agent list --status open --json` でコメントを取得し対応する（Phase 1 と同じフロー）
5. ユーザーが承認を伝えたら Phase 4 に進む

---

## Phase 4: 完了

superpowers の finishing-a-development-branch を実行する。

---

## Progress Ledger

subagent-driven-development の progress ledger をそのまま使う。このスキルが追加する記法:

```markdown
Task N: complete (commits abc1234..def5678, review clean)
Task N: complete (commits abc1234..def5678, review clean after fix — <修正内容>)
Task N: complete (commits abc1234..def5678, design-decision: <設計判断> → <棄却した finding>)
```

---

## Red Flags

- spec / plan を diffity レビューに通さず実装に入る
- code-reviewer を起動せずにタスクを完了させる
- Critical finding をユーザーの設計判断なしに棄却する
- 全体レビューをスキップする
- 複数の修正を1コミットにまとめる
- progress ledger を更新せずに次のタスクに進む
