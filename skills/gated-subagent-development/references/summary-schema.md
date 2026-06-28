# summary.jsonl スキーマ

`./.gated-subagent-dev/<yyyymmddHHMMSS>-summary.jsonl` の各行は以下のいずれか。`type` フィールドで判別する。タイムスタンプは ISO 8601。

## `meta` (1 件、先頭)

```json
{
  "type": "meta",
  "run_id": "string",
  "started_at": "2026-05-02T14:30:22+09:00",
  "finished_at": "2026-05-02T15:12:08+09:00",
  "user_request": "ユーザー依頼の原文",
  "review_config_path": ".gated-subagent-dev/review-config.yml",
  "max_review_iterations": 3
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
  "rule": "spec-compliance",
  "severity": "critical",
  "file": "src/foo.ts:42",
  "message": "指摘内容（1〜2 文に要約）",
  "resolution": "fixed",
  "label": "essential",
  "label_comment": ""
}
```

### resolution の値

- `fixed` — 次の review iteration で同等の finding が消えている
- `ignored` — 最終 iteration まで残ったが、stop_when 通過で commit された
- `dropped` — replan 等でレビュー外の理由で finding が無効になった

### label の値

- `essential` — 本質的な指摘
- `noise` — ノイズ
- `borderline` — 判断が難しい
- `config-smell` — stop_when 設定不一致の疑い
- `null` — 未確認

## `commit_rating` (commit ごとのユーザー評価)

```json
{
  "type": "commit_rating",
  "commit_seq": 1,
  "hash": "abc1234",
  "rating": "good",
  "comment": ""
}
```

### rating の値

- `good` / `mixed` / `bad` / `null`

## 並び順

1. `meta`
2. 各 commit について `commit` → 紐づく `finding` を `review_iter` 昇順
3. 全 commit ぶん終わったら `commit_rating` を seq 順
