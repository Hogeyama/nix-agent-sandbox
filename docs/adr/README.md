# ADR (Architecture Decision Records)

このディレクトリは nas プロジェクトの意思決定記録 (Nygard 流 ADR) を持つ。
**「過去どう決めたか」を保存する場所**であり、現在のコード仕様を書く
リファレンスではない (それはコード本体・各モジュールの doc comment が担う)。

## ファイル名

`YYYYMMDDNN-<short-slug>.md` (日付 + 同日連番 2 桁 + ハイフン区切り slug)。
例: `2026051401-history-db-migration-mechanism.md` = 2026-05-14 の 1 本目。
連番は同日に複数本書く場合に衝突回避するためのもので、ゼロ埋め 2 桁。

## frontmatter

```
---
Status: Draft | Accepted | Superseded by ADR-YYYYMMDDNN
Date: YYYY-MM-DD
---

# ADR: <title>
```

タイトル行の `(Draft)` は **Draft 中のみ** 付ける。Accepted / Superseded
に遷移したら `# ADR:` だけにする。

## Status の遷移ルール

```
Draft  ──(team agreement + 実装方針確定)──▶  Accepted  ──(後続 ADR で方針差し替え)──▶  Superseded by ADR-NNNN
```

### Draft

検討中。本文は加筆・書き換えしてよい。実装が始まる前 / merge 前のステージ。

### Accepted

**意思決定として確定したスナップショット**。基本的に **本文は immutable**。
許される編集:

- typo / link 切れ / 表記揺れの修正
- 実装後に判明した小さな事実誤認の訂正 (理由をコミットメッセージで明記)
- 後続 ADR との関係を示す `> **Update YYYY-MM-DD**: ...` 形式の inline
  note 追加 (本文は触らない)

**意思決定そのものを書き換えるのは禁止**。方針が変わったときは新規 ADR を
起票する (下記 supersession 規則)。

### Superseded by ADR-NNNN

新しい ADR で方針が改められた場合の終端 status。frontmatter の
`Status:` 行を `Superseded by ADR-2026MMDDNN` に書き換える以外、本文は
原則 immutable (当時の意思決定の記録として残す)。

## Supersession

### 全文 supersede

ADR-A の意思決定全体が ADR-B で覆る場合:

1. ADR-A の frontmatter `Status:` を `Superseded by ADR-B` に変更
2. ADR-A 本文は触らない (当時の文脈を保存する)
3. ADR-B の `## Context` で ADR-A を引用し、なぜ覆ったかを書く

### Partial supersede (セクション単位)

ADR-A の **一部のセクションだけ** が後で改められる場合 (= 残りのセクションは
依然有効)。frontmatter の Status は Accepted のまま、影響範囲のセクション
直下に inline note を入れる:

```markdown
### Storage: SQLite (...)

- ... (元の本文をそのまま残す)
- `PRAGMA user_version` で schema 版を管理。open 時に不一致なら migration を
  試みず refuse する ...

> **Update 2026-05-14**: writer 側の migration 方針はこのバレットからは外れ、
> ADR 2026051401 で記述される auto-migration 機構に置き換わった。当該 ADR
> を参照のこと。本文は当時の意思決定の記録として残す。
```

本文は **書き換えず**、inline note で「ここから先は別 ADR が引き継いだ」
ことだけ示す。新 ADR の `## Consequences` でも「この ADR のどのセクションを
覆ったか」を明記する。

理由: partial 場合は frontmatter Status を `Superseded by` にすると残りの
有効なセクションまで「無効化された」と読者に誤解される。本文 immutable +
inline note が一番ノイズの少ない着地点になる。

## レビュー観点 (作成時)

新規 ADR を起票する人は、最低限次を埋める:

- `## Context`: なぜこの意思決定が必要になったか。状況・痛み・選択肢の前提
- `## Decision`: 何を決めたか。複数の決定が絡む場合はサブセクション
- `## Alternatives considered`: 検討して却下した案と却下理由
- `## Consequences`: この決定によって生じる結果。トレードオフ、影響範囲、
  既存 ADR との関係 (partial supersede を含む)

## 既存 ADR 一覧

| File | Status | 主題 |
|---|---|---|
| `2026041801-xpra-runtime-gc.md` | Accepted | xpra runtime GC |
| `2026042801-ui-redesign-3pane-solid.md` | Accepted | UI 3-pane + Solid 移行 |
| `2026042802-forward-port-uds-relay.md` | Accepted | forward-port を UDS relay 化 |
| `2026042901-observability-otel-history.md` | Accepted | OTEL receiver + history.db |
| `2026050201-history-cost-table.md` | Accepted | history page の cost table |
| `2026051301-observability-logs-signal-ingest.md` | Accepted | OTLP /v1/logs ingest |
| `2026051401-history-db-migration-mechanism.md` | Accepted | history.db migration 機構 |
| `2026051501-history-drop-turn-events-and-summary-table.md` | Accepted | turn_events / conversation_summaries 撤去と summary の read-time derive |
| `2026051502-history-db-retention.md` | Accepted | history.db OTEL レコードの保存期間 (retention) 機構 |
| `2026051601-otel-ingest-module-structure.md` | Accepted | OTEL ingest module 構造 (otlp_wire 抽出 + transform/write 分離) |
| `2026051602-otlp-semantics-module-location.md` | Accepted | OTLP semantics モジュールの所属 (src/agents/ → src/history/) |
