# Blind Re-Review による妥当性チェック

review-config.yml のルール変更が検出力を改善するかどうかを、過去の bad commit への blind re-review で検証する手順。

## なぜ blind re-review が必要か

review-config.yml を変更した後、「この変更で本当に改善されるか」を確認したい。実際の bad commit の diff を、新ルールを持った reviewer に**答えを教えずに**レビューさせることで、新ルールの実効性を測定できる。

## 手順

### 1. Bad commit の特定

summary.jsonl から commit_rating が `bad` のコミットを抽出する。

- 抽出結果が 3 件未満の場合はサンプル不足として報告し、ユーザーに判断を仰ぐ
- 各 hash が git history に存在するか確認し、存在しないものはスキップする

### 2. review-config.yml の読み込み

`.gated-subagent-dev/review-config.yml` を読み、rules セクションの description をそのまま reviewer プロンプトに埋め込む。

### 3. Blind re-review の実行

各 bad commit に対して Agent を起動する。複数件ある場合は並列で回す。

- **bad_comment は渡さない。** 答えを教えた状態のレビューは評価にならない
- reviewer が `git show <HASH> --format=""` で差分を確認し、`git show <HASH>:<filepath>` で周辺コードを読める状態にする
- diff だけでなく、変更されたファイルの周辺コード・関連ファイルを必ず確認するよう指示する

### 4. 結果の判定

各 bad commit について、reviewer の findings と bad_comment を突合する。

- **検出**: bad_comment が指す問題と同じ趣旨の finding があるか
- **severity**: その finding が critical か
- **差し戻し**: そのルールの stop_when と severity の組み合わせで差し戻しが発生するか

### 5. 結果の報告

| commit | hash | 既知の問題 | critical で検出？ | 差し戻し？ | 備考 |

テーブルの後に:
- **検出率**: N 件中 M 件を critical として検出
- **見逃し分析**: severity ガイド不足 / 調査深度不足 / カバー外に分類
- **総合判定**: ルール変更が妥当かどうかの所見
