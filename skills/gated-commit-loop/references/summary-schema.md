# summary.jsonl スキーマ

`./.gated-commit-loop/<yyyymmddHHMMSS>-summary.jsonl` の各行は以下のいずれか。`type` フィールドで判別する。タイムスタンプは ISO 8601。

## `meta` (1 件、先頭)

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

## `plan` (各 plan iteration)

```json
{
  "type": "plan",
  "iter": 1,
  "verdict": "approve" | "reject",
  "reviewer_reason": "reject の場合のみ。approve では空文字でよい"
}
```

## `plan_user` (ユーザー判断)

```json
{
  "type": "plan_user",
  "iter": 2,
  "verdict": "approve" | "revise" | "abort",
  "comment": ""
}
```

## `commit` (各コミット)

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

## `finding` (review iteration ごとに発生した指摘)

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
  "label": "essential" | "noise" | "borderline" | "config-smell" | null,
  "label_comment": ""
}
```

## `commit_rating` (commit ごとのユーザー評価)

```json
{
  "type": "commit_rating",
  "commit_seq": 1,
  "hash": "abc1234",
  "rating": "good" | "mixed" | "bad" | null,
  "comment": ""
}
```

## 並び順

1. `meta`
2. `plan` / `plan_user` を時系列順
3. 各 commit について `commit` → 紐づく `finding` を `review_iter` 昇順
4. 全 commit ぶん終わったら `commit_rating` を seq 順

集計スクリプト側はこの順序を前提にしてよい（ファイル全体を読んでから集計する場合は順序非依存に処理してもよい）。
