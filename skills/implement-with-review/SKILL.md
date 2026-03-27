---
name: implement-with-review
description: 実装後に自動でレビューと修正を繰り返し、品質を担保するワークフロー
user-invocable: true
argument-hint: "[実装内容の説明]"
---

# Enterprise Implement-with-Review

計画→レビュー→実装(1コミット単位)のループで品質を担保するワークフロー。

## 原則

- **orchestrator（あなた）はコードの読み書きを一切しない。** 初期調査も含めすべてサブエージェントに委任する。
- **orchestrator のコンテキストは貴重。** ファイル内容の確認や探索的な調査はサブエージェントの仕事。
- **1 implementer = 1 コミット。** プラン外の作業は禁止。

## サブエージェント

| 役割 | 定義ファイル | 使い方 |
|------|-------------|--------|
| planner | `agents/planner.md` | コードベース調査 + コミット粒度の計画作成 |
| plan-reviewer | `agents/plan-reviewer.md` | 計画のレビュー (approve/reject) |
| implementer | `agents/implementer.md` | 1コミット分の実装 |
| code-reviewer | `agents/code-reviewer.md` | コミットのコードレビュー |

各サブエージェントの詳細な手順・出力フォーマット・制約は定義ファイルに記載済み。
orchestrator は定義ファイルの内容を把握する必要はなく、タスク内容を渡すだけでよい。

## ワークフロー

```
User request
  ↓
[Step 1] 設定読み込み (review-config.yml)
  ↓
[Step 2] Plan Loop
  planner → plan-reviewer → approve? → ユーザー確認 → approve? → Step 3
                                                     → 修正指示? → planner に FB して再計画
                           → reject?  → planner に FB して再計画
                           → N回失敗? → ユーザーに判断を委ねる
  ↓
[Step 3] Commit Loop (計画の各コミットについて)
  implementer (1コミット分)
    → done?    → code-reviewer → approve? → /commit → 次のコミット
    →                          → reject?  → implementer に修正させる (max M回)
    → blocked? → planner に残り計画を練り直させる → Step 2 に戻る
  ↓
[Step 4] 完了報告
```

### Step 1: 設定の読み込み

`./review-config.yml` を読み、以下を確認:
- `max_plan_iterations`: 計画フェーズのループ上限
- `max_review_iterations`: 各コミットのレビューループ上限
- `stop_when`: コードレビューのデフォルト終了条件
- `rules`: レビュー観点（ルールごとに `stop_when` を上書き可能）

### Step 2: Plan Loop

1. **planner** を呼ぶ。渡す情報:
   - ユーザーの実装指示
   - (再計画の場合) plan-reviewer の reject findings
   - (差し戻しの場合) implementer の blocked reason + 完了済みコミット情報

2. **plan-reviewer** を呼ぶ。渡す情報:
   - ユーザーの元の指示
   - planner の出力（計画）

3. 判定:
   - **approve** → 4 へ
   - **reject** → findings を添えて planner を再度呼ぶ (1 に戻る)
   - **max_plan_iterations 到達** → ユーザーに計画と指摘を見せて判断を委ねる

4. **ユーザーに計画を提示して確認を取る。** 計画全体（コミット一覧・scope・変更ファイル）を見せ、以下を問う:
   - **LGTM** → Step 3 へ
   - **修正指示あり** → ユーザーのフィードバックを添えて planner を再度呼ぶ (1 に戻る。plan-reviewer の reject と同様に扱う)

### Step 3: Commit Loop

承認された計画の各コミットについて:

1. **implementer** を呼ぶ。渡す情報:
   - 承認された計画全体（参照用）
   - 今回実装する Commit の詳細
   - (修正の場合) code-reviewer の reject findings

2. 結果を処理:
   - **status: done** → 3 へ
   - **status: blocked** → reason と suggestion を planner に渡して残り計画を練り直す (Step 2 に戻る、完了済みコミットは維持)

3. **code-reviewer** を呼ぶ。渡す情報:
   - review-config.yml の rules
   - 今回の Commit の計画

4. レビュー結果の判定:
   各 finding について、そのルールの `stop_when` (なければグローバルの `stop_when`) を適用する:
   - `no_critical_findings`: そのルールの critical findings がなければ OK
   - `no_findings`: そのルールの findings が一切なければ OK (warning/info も差し戻し対象)
   判定:
   - **全ルール OK** → `/commit` スキルでコミット → 次の Commit へ
   - **いずれかのルールが NG** → 該当 findings を implementer に渡して修正 (1 に戻る、max_review_iterations まで)
   - 修正ループ上限到達 → ユーザーに判断を委ねる

### Step 4: 完了報告

全コミット完了後:
- 実行されたコミット一覧 (hash + message)
- 各コミットのレビュー結果サマリー
- 残った warnings/info（あれば）
