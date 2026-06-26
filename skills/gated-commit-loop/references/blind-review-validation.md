# Blind Re-Review による妥当性チェック

review-config.yml のルール変更が検出力を改善するかどうかを、過去の bad commit への
blind re-review で検証する手順。tuning-rules.md ステップ 6 から参照される。

## なぜ blind re-review が必要か

review-config.yml を変更した後、「この変更で本当に改善されるか」を確認したい。
単純なキーワードマッチや推測では精度が低い。実際の bad commit の diff を、
新ルールを持った reviewer に**答えを教えずに**レビューさせることで、
新ルールの実効性を測定できる。

diff だけでなくファイル全体を読める状態にすることも重要。
reviewer が周辺コードの慣習やファイル間依存を確認できないと、
実際のレビューとは異なる条件になり、評価の信頼性が下がる。

## 手順

### 1. Bad commit の特定

summary.jsonl から commit_rating が `bad` のコミットを抽出する。

```bash
cat .gated-commit-loop/*-summary.jsonl | python3 -c "
import json, sys

commits = []
ratings = []
current_run = None

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: obj = json.loads(line)
    except: continue
    if obj.get('type') == 'meta':
        current_run = obj.get('run_id', '')
    elif obj.get('type') == 'commit':
        obj['_run'] = current_run
        commits.append(obj)
    elif obj.get('type') == 'commit_rating':
        obj['_run'] = current_run
        ratings.append(obj)

for r in ratings:
    if r.get('rating') == 'bad':
        seq = r.get('commit_seq')
        run = r.get('_run', '')
        for c in commits:
            if c.get('seq') == seq and c.get('_run') == run:
                print(json.dumps({
                    'hash': c.get('hash'),
                    'title': c.get('title'),
                    'bad_comment': r.get('comment', '')
                }))
                break
"
```

- run_id が各行に入っていない場合は meta 行を区切りとして直前の run_id を付与する
- 抽出結果が 3 件未満の場合はサンプル不足として報告し、ユーザーに判断を仰ぐ
- 各 hash が git history に存在するか `git show <hash> --stat` で確認し、存在しないものはスキップする

### 2. review-config.yml の読み込み

`.gated-commit-loop/review-config.yml` を読み、rules セクションを取得する。
各ルールの description（severity 使い分けガイドを含む）をそのまま reviewer プロンプトに埋め込む。

### 3. Blind re-review の実行

各 bad commit に対して Agent を起動する。複数件ある場合は**並列で回す**。

#### 守るべきこと

- **bad_comment は渡さない。** 答えを教えた状態のレビューは評価にならない
- **ファイルアクセス方法を明示する。** reviewer が自律的に周辺コードを調査できるようにする
- **手順で「周辺コードを読め」と指示する。** diff だけ見て終わる reviewer にしない

#### プロンプトテンプレート

```
あなたはコードレビューの専門家です。指定されたコミットの変更を、
周辺コードを含めてレビューしてください。

## 対象コミット

hash: <HASH>

差分を見るには `git show <HASH> --format=""` を使ってください。
そのコミット時点のファイルを読むには `git show <HASH>:<filepath>` を使ってください。
差分だけでなく、変更されたファイルの周辺コード、既存の慣習、
関連ファイル（import 先、amends 先、ビルド設定等）を必ず確認してください。

## レビュールール

<review-config.yml の rules をここに展開>

## 手順

1. `git show <HASH> --format=""` で差分を確認
2. 変更されたファイルの全体像を `git show <HASH>:<path>` で確認
   （特に同じファイル内の既存パターンや慣習を把握する）
3. 変更された関数・メソッドのすべての分岐パスを確認
4. 関連ファイル（import 先、型定義、ビルド設定等）を確認
5. 各ルールで findings を報告

## 出力

JSON 単一オブジェクトを返してください。前後に説明文を出さないでください。

{
  "passed": true/false,
  "findings": [
    {
      "rule": "rule-name",
      "severity": "critical/warning",
      "file": "path:line",
      "message": "1〜2文の指摘"
    }
  ],
  "summary": { "critical": 0, "warning": 0 }
}
```

### 4. 結果の判定

各 bad commit について、reviewer の findings と bad_comment を突合する。

判定基準:
- **検出**: bad_comment が指す問題と同じ趣旨の finding があるか
- **severity**: その finding が critical か
- **差し戻し**: そのルールの stop_when と severity の組み合わせで差し戻しが発生するか

「同じ趣旨」の判定は orchestrator が行う。完全一致は不要だが、
bad_comment の根本原因と finding の指摘が同じ問題を指しているかを確認する。

### 5. 結果の報告

以下のテーブルをユーザーに提示する:

```
| commit | hash | 既知の問題 | critical で検出？ | 差し戻し？ | 備考 |
```

テーブルの後に:

- **検出率**: N 件中 M 件を critical として検出
- **見逃し分析**: 検出できなかった commit について、原因を分類する
  - **severity ガイド不足**: reviewer は問題を見つけたが warning にとどめた → description の severity ガイドを強化すべき
  - **調査深度不足**: reviewer がそもそも問題を発見できなかった → description ではなく reviewer の手順指示やルールのカバー範囲の問題
  - **カバー外**: 既存ルールのいずれにも該当しない問題 → 新ルール追加の検討材料
- **総合判定**: ルール変更が妥当かどうかの所見
