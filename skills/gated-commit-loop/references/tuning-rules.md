# review-config.yml チューニングガイド

`./.gated-commit-loop/*-summary.jsonl` を読んで `./.gated-commit-loop/review-config.yml`（project-local copy）の rules を見直すためのガイド。`gated-commit-loop` スキル本体とは独立した活動なので、ユーザーが「review-config を見直したい」「ルールチューニングしたい」と言ったときにこのファイルを開く。

**編集対象は常に `./.gated-commit-loop/review-config.yml`。** スキル側の `skills/gated-commit-loop/review-config.template.yml` はテンプレートなので触らない（触ると新規 project の初期値が変わる）。

## このガイドの前提

- 集計対象は `./.gated-commit-loop/*-summary.jsonl`。各ファイルが 1 ラン分。
- スキーマは SKILL.md の「Appendix: summary.jsonl スキーマ」を参照。
- 判断材料の核は **finding.label**（ユーザーが essential / noise / borderline / null を付けたもの）と **finding.resolution**（fixed / ignored / dropped）。
- `label = null` は「未確認」。`label = noise` とは違うので集計時に必ず分けて扱う。

## 手順

### 1. 集計対象を決める

直近 10〜20 ラン程度を見るのが目安。少なすぎると 1 ラン特殊事情で歪み、多すぎるとルール変更前後が混ざって判断がブレる。`review-config.yml` を最後に変更したコミット以降のラン**だけ**を対象にする方が、現行ルールに対する評価として正確。

```bash
# 例: 直近 10 件
ls -1t .gated-commit-loop/*-summary.jsonl | head -10
```

### 2. rule 別に基本指標を出す

各 rule について次を集計する。**サンプル 3 件未満の rule は判断保留**（ノイズで結論を出さない）。

| 指標 | 定義 | 何を示すか |
|------|------|-----------|
| `total` | その rule が出した finding の総数 | rule の活動量 |
| `fixed_rate` | `resolution=fixed` / `total` | 差し戻しを引き起こす力 |
| `ignored_rate` | `resolution=ignored` / `total` | 通過させてる率(severity が高すぎないかの指標) |
| `essential_rate` | `label=essential` / `(label != null)` | 本質的な指摘の割合 |
| `noise_rate` | `label=noise` / `(label != null)` | ノイズ率 |
| `unlabeled_rate` | `label=null` / `total` | 評価できない部分 |

`unlabeled_rate` が高い rule は判断材料が足りない。先にユーザーにラベル付けを促す。

### 3. 自由記述に目を通す

数字だけでは見えない構造的フィードバックがある:

- `finding.label_comment` — 「rule が広すぎる」「文言が曖昧」「具体例が欲しい」など
- `commit_rating.comment` — 「ここで X の指摘がほしかったのに出なかった」など、**rule の取りこぼし**を拾えるのはここだけ

label_comment を rule 別にまとめて読むと改善の方向性が見える。

### 4. 判定ヒューリスティック

```
noise_rate > 0.5 かつ total >= 5
  → severity を一段下げる、または rule 削除を検討
  → label_comment に「広すぎる」が複数出ていれば description を絞る方向

essential_rate > 0.7 かつ severity が warning 以下
  → severity 格上げ(warning → critical)を検討

ignored_rate > 0.7 かつ severity = critical
  → そもそも critical が機能していない(stop_when 設定ミスの可能性も含めて確認)

fixed_rate が高く essential_rate も高い
  → rule は機能している。触らない

同じ rule が同一 commit で複数回 firing(seq が同じで rule が複数回出る)
  → rule の粒度が荒い。サブルール分割を検討

commit_rating.comment に「X の観点が抜けていた」が複数件
  → 既存ルールでカバーできていない領域。新規 rule を起こす候補
```

### 5. 改定案をユーザーに提示する

集計結果と改定案をセットで出す。**数字を出さずに「直したほうがよい」とだけ言わない。** 例:

```
- naming (info): total=12, noise_rate=0.75
  → 削除候補。label_comment で「個人差が大きい」「指摘されても直さない」が頻出
- design (warning): total=8, essential_rate=0.83, fixed_rate=0.62
  → 維持。critical 格上げも検討余地あるが、誤検知時のコストが高いので warning のまま推奨
- (新規) test-isolation (warning): commit_rating.comment で「テスト間の依存」指摘漏れが 3 件
  → 新ルール追加を提案
```

ユーザー承認を得てから `review-config.yml` を編集する。

### 6. 改定後の妥当性チェック

直近 1〜2 件の summary.jsonl を持ち出して、「もし新ルールだったら」を目視シミュレートする。新ルールで noise が増えそう / 既存 essential を取りこぼしそう、という兆候があれば改定をやり直す。

## 注意点

- **ラベル未確認のラン (`label=null` 過半数) を主たる判断根拠にしない。** 判断するなら最低限ラベル付き finding が rule あたり 5 件以上ほしい。
- **1 ラン中の連続 firing を別事象として数えない。** 同じバグが 3 行に出ただけのケースは rule の noise として扱うべきではない。集計時は「ユニークな (commit, rule, message要約) 単位」で重複を畳むかどうかを最初に決める。
- **review-config.yml を変えたら、変更理由を yaml コメントに残す。** 半年後に「なぜ severity を下げたんだっけ」と迷わないため。
- **ルール削除は履歴から復活できるので恐れない。** noise_rate が高い rule を温存する方がコスト高。
