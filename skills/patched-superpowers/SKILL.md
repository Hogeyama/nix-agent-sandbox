---
name: patched-superpowers
description: 開発タスクで using-superpowers の代わりに使う。superpowers ワークフローに、人間レビューゲートとルールベースのコードレビューを組み込む。
user-invocable: true
argument-hint: '[実装内容の説明]'
---

# Patched Superpowers

superpowers のワークフロー（brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch）に、以下の補正を加えて実行する。

## docs/superpowers が独立リポジトリの場合

superpowers の brainstorming / writing-plans は `docs/superpowers/specs/` と `docs/superpowers/plans/` にファイルを書く。このディレクトリが親プロジェクトと別の git リポジトリである場合、以下を守る:

- **spec/plan の git 操作（commit, diff）は `docs/superpowers/` ディレクトリで実行する**。`git -C docs/superpowers commit ...` を使う。親リポジトリで commit しない
- **diffity も `docs/superpowers/` ディレクトリで起動する**。`(cd docs/superpowers && diffity tree)` のようにする。親リポジトリから起動すると spec/plan の変更が見えない
- **Phase 2 以降の実装コードの git 操作・diffity は親リポジトリで実行する**。実装コードは親リポジトリに属するため
- 判定方法: `docs/superpowers/.git` が存在すれば独立リポジトリ

## 起動時にやること

1. 前提スキルの確認: `superpowers:brainstorming`、`superpowers:writing-plans`、`superpowers:subagent-driven-development` がスキル一覧に存在するか確認する。存在しないものがあればユーザーに伝えて停止する。また `diffity` CLI が利用可能か `which diffity` で確認する
2. `docs/superpowers/.git` の存在を確認し、独立リポジトリかどうかを判定する
3. ユーザーに、設計・実装に先立って読んでおくべきドキュメントやスキルがないか確認する（例: コーディング規約、アーキテクチャガイド、既存の設計ドキュメントなど）。ユーザーが指定したものがあれば Skill ツールや Read ツールで読み、内容を把握しておく
4. Skill ツールで `superpowers:brainstorming` を呼び出す
5. 以下の補正を Phase ごとに適用する

---

## コミットメッセージ

すべてのフェーズでコミットする際は、`git-commit` スキルに従う。Skill ツールで `git-commit` を読み、そのワークフローとフォーマットでコミットメッセージを生成する。

`git-commit` スキルが利用できない場合はユーザーに伝えて確認を取る。

### plan / spec を読まないと理解できない情報を書かない

コミットメッセージは、その commit の diff だけを見る読者が単体で理解できるように記述する。plan や spec を開かないと意味が通じない参照（「spec の決定どおり」「Task 3 の方針に従う」など）を body に含めない。

設計判断の根拠・棄却した代替案・制約を body に反映する場合も、plan / spec の記述を前提にせず、その commit だけで完結するように具体的に記述する。設計の全体像は spec の Why / Why Not が担うので、コミットメッセージ側で spec を要約・複製する必要はない。

---

## Phase 1: 設計（brainstorming + writing-plans）

superpowers の brainstorming → writing-plans を実行しつつ、以下を追加する。

### spec に Why / Why Not を含める

brainstorming が生成する spec に、設計判断の根拠を記載する。spec の末尾に以下の2セクションを追加する:

```markdown
## Why — なぜこのアプローチを選んだか

[brainstorming で検討した複数案のうち、この案を選んだ決め手。
判断基準（パフォーマンス、保守性、既存コードとの整合性など）を具体的に書く。]

## Why Not — なぜ他の案を選ばなかったか

- **案 B: [案の名前]** — [棄却理由]
- **案 C: [案の名前]** — [棄却理由]
```

brainstorming では複数のアプローチを検討して1つに絞る。このとき「なぜこの案を選び、なぜ他を捨てたか」が spec に残っていないと、後工程で設計意図が失われる。実装中に迷ったとき「この設計はXを優先してYを捨てた判断だ」と立ち戻れるようにする。

### 事前読み込み済みドキュメントの活用

起動時ステップ 3 でユーザーが指定したドキュメントやスキルの内容を設計判断に反映する。writing-plans では Global Constraints にこれらのドキュメント名・スキル名を列挙し、実装者・レビュアーに読ませる指示を明記する。

### spec と plan の人間レビュー

spec と plan をそれぞれ書き終えたら、次のフェーズに進む前に diffity でユーザーにレビューしてもらう。ユーザーが承認するまで先に進まない。

spec/plan はドキュメントなので、diff（差分）ではなく tree（ファイル閲覧）でレビューする。ツアーは不要 — ユーザーが自分で読んでコメントすればいい。

手順:

1. spec/plan をコミットする（docs/superpowers が独立リポジトリの場合は `docs/superpowers/` で実行）
2. 設計中に自信のなかった判断や迷った点があればユーザーに伝える。ユーザーがレビューで注目すべき箇所の手がかりになる
3. `diffity tree` を起動する（docs/superpowers が独立リポジトリの場合は `(cd docs/superpowers && diffity tree)`）。`diffity list --json` でポートを取得し、spec と plan それぞれのファイルを直接開く URL をユーザーに渡す。形式: `http://localhost:<port>/tree?path=<urlエンコード済みパス>&type=file`。ユーザーにレビューを依頼する
4. ユーザーがブラウザでコメントを付けて知らせてきたら、`diffity agent list --status open --json` でコメントを取得する
5. 各コメントに対応する — 修正が必要なら修正し `diffity agent resolve <id> --summary "..."` で解決、質問なら `diffity agent reply <id> --body "..."` で返答
6. 修正をまとめてコミットする。spec/plan は実装コードと違い細かいコミット履歴に意味がないので、前回のコミットに squash (`git commit --amend`) してよい
7. open コメントがなくなったらユーザーに承認を求める。ユーザーが追加コメントを付けた場合は 4-6 を繰り返す

### Phase 1 の完了条件

spec と plan の両方でユーザーが承認したこと。

---

## Phase 2: 実装（subagent-driven-development ベース）

superpowers の subagent-driven-development を実行しつつ、以下を変更する。実行方式の選択肢をユーザーに提示せず、subagent-driven-development で直ちに開始する。

### 実装開始前に base ref を記録する

最初のタスクに着手する前に、現在の HEAD のコミットハッシュを progress ledger に `implementation-base: <hash>` として記録する。Phase 3 の全体 diff レビューでこの値を base ref として使う。ブランチに先行コミットがある場合でも、ここで記録した地点から先だけがレビュー対象になる。

### タスクごとのレビューで独自の code-reviewer を使う

superpowers の task-reviewer の代わりに、このスキル同梱の code-reviewer（`code-reviewer-prompt.md`）を使う。

code-reviewer は `./.superpowers/review-config.yml` のルールに基づいてレビューし、JSON で findings を返す。初回実行時に review-config.yml が存在しなければ、このスキルディレクトリの `review-config.template.yml` をコピーする。`./.superpowers/.gitignore` がなければ `*` の1行で作る。

code-reviewer を Agent ツールで起動する際は、`code-reviewer-prompt.md` のプロンプト全文を読み、その内容を prompt に渡す。追加で以下を含める:
- 起動時にユーザーが指定したドキュメント・スキルの名前
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

実装コードの変更なので、tree ではなく diff（差分ビュー）でレビューする。

1. progress ledger から `implementation-base` のコミットハッシュを読む。これが diff の base ref になる
2. Skill ツールで `diffity-tour` を読み、`implementation-base..HEAD` の diff に対する Review mode のツアーを作成する
3. Skill ツールで `diffity-diff` を読み、`diffity <implementation-base>..HEAD` でブラウザを開く。ユーザーにレビューを依頼する
4. ユーザーがコメントを付けて知らせてきたら、`diffity agent list --status open --json` でコメントを取得する
5. 各コメントに対応する — 修正が必要なら修正し `diffity agent resolve <id> --summary "..."` で解決、質問なら `diffity agent reply <id> --body "..."` で返答
6. open コメントがなくなったらユーザーに承認を求める。ユーザーが追加コメントを付けた場合は 4-5 を繰り返す
7. ユーザーが承認を伝えたら Phase 4 に進む

---

## Phase 4: 完了

### コミット履歴のクリーンアップ

finishing-a-development-branch に進む前に、`implementation-base..HEAD` のコミットログを確認し、残す必要のないコミットを fixup する。

対象: レビュー指摘の1行修正、typo 修正、lint fix など、独立したコミットとして残す意味がなく、親コミットに吸収しても差分が自明なもの。設計判断や機能追加を含むコミットは触らない。

手順:

1. `git log --oneline implementation-base..HEAD` でコミット一覧を確認する
2. fixup 候補を特定し、ユーザーに提示して確認を取る
3. `/git-rewrite` で fixup を実行する（1コミットを複数のコミットに分割する場合も `/git-rewrite` に含まれる `references/git-split.md` の手順を使う）
4. fixup 後に `git log --oneline implementation-base..HEAD` で結果を確認する

### ブランチの完了

superpowers の finishing-a-development-branch を実行する。

---

## Progress Ledger

subagent-driven-development の progress ledger をそのまま使う。このスキルが追加する記法:

```markdown
implementation-base: 0d19d7dcd
Task N: complete (commits abc1234..def5678, review clean)
Task N: complete (commits abc1234..def5678, review clean after fix — <修正内容>)
Task N: complete (commits abc1234..def5678, design-decision: <設計判断> → <棄却した finding>)
```

`implementation-base` は Phase 2 の最初のタスク着手前に記録する。Phase 3 の diff レビューで base ref として使う。

---

## Red Flags

- spec / plan を diffity レビューに通さず実装に入る
- code-reviewer を起動せずにタスクを完了させる
- Critical finding をユーザーの設計判断なしに棄却する
- 全体レビューをスキップする
- 複数の修正を1コミットにまとめる
- progress ledger を更新せずに次のタスクに進む
- Phase 3 の diff ref に `implementation-base` 以外の値（ブランチ名、`main` など）を使う
- レビュー修正の1行 fixup コミットを整理せずにそのまま finish する
- fixup 対象をユーザーに確認せずに勝手にリライトする
