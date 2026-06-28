# review-config.yml チューニングガイド

`./.gated-subagent-dev/*-summary.jsonl` を読んで `./.gated-subagent-dev/review-config.yml` の rules を見直すためのガイド。ユーザーが「review-config を見直したい」「ルールチューニングしたい」と言ったときにこのファイルを開く。

**編集対象は常に `./.gated-subagent-dev/review-config.yml`。** スキル側の `review-config.template.yml` は触らない。

## 手順

### 1. 集計対象を決める

直近 10〜20 ラン程度。`review-config.yml` を最後に変更した以降のランだけを対象にする。

### 2. rule 別に基本指標を出す

各 rule について次を集計する。**サンプル 3 件未満の rule は判断保留。**

| 指標 | 定義 | 何を示すか |
|------|------|-----------|
| `total` | finding の総数 | rule の活動量 |
| `fixed_rate` | `resolution=fixed` / `total` | 差し戻しを引き起こす力 |
| `ignored_rate` | `resolution=ignored` / `total` | 通過させてる率 |
| `essential_rate` | `label=essential` / `(label != null)` | 本質的な指摘の割合 |
| `noise_rate` | `label=noise` / `(label != null)` | ノイズ率 |
| `unlabeled_rate` | `label=null` / `total` | 評価できない部分 |

### 3. 自由記述に目を通す

- `finding.label_comment` — rule の改善方向のヒント
- `commit_rating.comment` — rule の取りこぼしを拾える

### 4. 判定ヒューリスティック

```
noise_rate > 0.5 かつ total >= 5
  → severity を一段下げる、または rule 削除を検討

essential_rate > 0.7 かつ severity が warning 以下
  → severity 格上げを検討

ignored_rate > 0.7 かつ severity = critical
  → stop_when 設定ミスの可能性を確認

fixed_rate が高く essential_rate も高い
  → rule は機能している。触らない

同じ rule が同一 commit で複数回 firing
  → rule の粒度が荒い。サブルール分割を検討

commit_rating.comment に「X の観点が抜けていた」が複数件
  → 新規 rule を起こす候補
```

### 5. 改定案をユーザーに提示する

数字を出さずに「直したほうがよい」とだけ言わない。集計結果と改定案をセットで出す。

ユーザー承認を得てから `review-config.yml` を編集する。

### 6. 改定後の妥当性チェック

bad commit の blind re-review で新ルールの実効性を検証する。手順は `references/blind-review-validation.md` を参照。

## 注意点

- ラベル未確認のランを主たる判断根拠にしない
- 1 ラン中の連続 firing を別事象として数えない
- review-config.yml を変えたら、変更理由を yaml コメントに残す
- ルール削除は履歴から復活できるので恐れない
