---
Status: Draft
Date: 2026-05-13
---

# ADR (Draft): observability — /v1/logs 受理と event 単位 whitelist

## Context

ADR 2026042901 で導入した OTLP receiver は `/v1/traces` のみ受理。これだと
Claude Code の安定経路で取れない情報が複数ある:

- **user prompt 本文**: 公式チャネルは `claude_code.user_prompt` event
  (logs signal)。beta traces の span attr 経由でも取れるが、公式 doc に
  "not part of the stable span schema" と明記されており Anthropic が
  いつでも消せる
- **トークン会計の安定経路**: `api_request` event に
  input/output/cache_read/cache_creation/cost_usd が乗る。spans 側にも
  token attrs はあるが beta enhanced telemetry に依存
- **hook 実行ログ**: spans には乗らない。logs にのみ存在

実機検証 (`/v1/logs` 生 dump で確認、Claude `sess_f9fe7bbfd8ce`) で
`OTEL_LOGS_EXPORTER=otlp` のみで以下 8 種の event が吐かれることを確認:

| event.name | 主要 attr |
|---|---|
| `user_prompt` | `prompt`, `prompt.id`, `event.sequence`, `prompt_length` |
| `api_request` | `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `duration_ms`, `request_id` |
| `hook_execution_start/complete` | `hook_event`, `hook_name`, `num_hooks`, `total_duration_ms` |
| `internal_error` | `error_name`, `error_code` |
| `tool_result` | `tool_*`, `tool_result_size_bytes` (本文無し、サイズのみ) |
| `tool_decision` | `decision`, `tool_name`, `tool_use_id` |
| `skill_activated` | `skill.name`, `invocation_trigger`, `skill.source` |

全 record に `user.id` / `user.email` / `user.account_uuid` /
`user.account_id` が乗る (PII)。`organization.id` も乗るが workspace 識別子
であり PII ではない扱いとする。

## Decision

### `/v1/logs` を受理する

`POST /v1/logs` を receiver に追加。OTLP/JSON `ExportLogsServiceRequest`
を per-event 単位で ingest 判断する。Claude にだけ
`OTEL_LOGS_EXPORTER=otlp` を注入 (Copilot/Codex は別 commit)。

### ingest 対象は event 単位の whitelist

| event.name | 採否 | 理由 |
|---|---|---|
| `user_prompt` | **採用** | 本 ADR の主目的。`prompt` 本文を保存 |
| `api_request` | **採用** | トークン会計の安定経路。spans 側より docs の安定保証が強い |
| `hook_execution_start/complete` | **採用** | デバッグ用途。他シグナルに代替無し |
| `internal_error` | 不採用 | attr は `error_name` / `error_code` のみで情報量が薄い。Claude debug log / stderr で代替できる |
| `tool_result` | 不採用 | サイズのみ。本文は trace の `tool.output` span event 側で取れる |
| `tool_decision` | 不採用 | bypass-permissions 運用なので allow/deny に意味が無い |
| `skill_activated` | 不採用 | 同等情報が `claude_code.tool` span (kind=Skill) に乗る |
| `api_request_body` / `api_response_body` | 不採用 | `OTEL_LOG_RAW_API_BODIES=1` 時のみ発生。本文系は trace 側で十分 |

未知の event 名は drop し warn ログを残す (将来 Claude が追加した event を
silently ingest しない安全側)。

### 二系統前提のチャネル設計

- **logs**: prompt 本文 / トークン会計 / hook
- **traces**: span 階層 / tool I/O 本文 (`tool.output` span event) /
  conversation-id 紐付け

両者を独立テーブルに保存し、UI 側で turn 単位に結合する。logs を spans
に吸収するモデルは取らない (event の親子は span tree ではなく `prompt.id`
平坦のため)。

### 相関キー: `session.id` + `prompt.id`

実機検証で確認した log record の identity 構造:

- OTLP top-level の `traceId` / `spanId` は **空** (全 record で確認)。
  Claude は logs を traces と紐付けて吐かない
- 各 record の attr に `session.id` (= Claude conversation id) が必ず乗る
  (2204/2204 で確認)
- 各 record の attr に `prompt.id` (= user_prompt ごとに振られる turn
  ローカル ID) が必ず乗る (2204/2204 で確認)
- `event.sequence` は **conversation 単位の単調増加** (multi-turn 検証:
  prompt #1: 0–348、prompt #2: 349–1508、prompt #3: 1509–2205。
  prompt 境界で gap も reset もなし)
- resource attr の `nas.session.id` で invocation が辿れる

紐付け経路:

- log_records → invocation: `nas.session.id` (resource) 直
- log_records → conversation: `session.id` (record attr) → conversations.id
- 同一 turn の event 列: `prompt.id` で GROUP BY、`event.sequence` で ordering
  (sequence は conversation 単位の単調増加のため、prompt サブセット内でも昇順が保たれる)
- **prompt.id → trace_id**: logs `api_request` event の `request_id` と spans
  `claude_code.llm_request` の `request_id` が 1:1 で一致 (実機検証で
  7 / 7 一致、対応 spans の trace_id は単一)。turn 内のいずれかの
  `api_request` を経由して trace を引ける

`request_id` は `log_records` の独立 column として promote し、span 側は
`attrs_json` の `request_id` を `json_extract` で参照する (spans の token
column と同様、span attrs は promote しない方針を踏襲)。

### 1 trace = 1 prompt.id = 1 user_prompt の invariant

マルチターン (3 prompt.id / 3 trace_id) を含む実機検証 (2204 records) で
violation 0。**1 trace ⇔ 1 prompt.id ⇔ 1 user_prompt event の 1:1:1**
を前提とする。

実装上の含意:
- reader は trace ごとに `userPromptText: string | null` をスカラ 1 個と
  して扱う (配列不要)
- 万一同一 trace に user_prompt event が 2 件以上来た場合は `ORDER BY time
  ASC LIMIT 1` で先頭を採用し warn ログを残す (silently 落とさない)

### PII redaction: spans と同じ規則を再利用

`ingest.ts` の `PII_ATTR_KEYS` (`user.id` / `user.email` /
`user.account_uuid` / `user.account_id`) を log records にも適用する。
`organization.id` は workspace 識別子であり PII 対象外。

### Schema (log_records テーブル)

```sql
CREATE TABLE log_records (
  invocation_id    TEXT NOT NULL REFERENCES invocations(id),
  conversation_id  TEXT NOT NULL REFERENCES conversations(id),
  prompt_id        TEXT NOT NULL,
  sequence         INTEGER NOT NULL,
  event_name       TEXT NOT NULL,
  time             TEXT NOT NULL,
  request_id       TEXT,
  attrs_json       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (conversation_id, sequence)
);

CREATE INDEX idx_log_records_invocation
  ON log_records(invocation_id);
CREATE INDEX idx_log_records_conv_prompt
  ON log_records(conversation_id, prompt_id);
CREATE INDEX idx_log_records_request_id
  ON log_records(request_id) WHERE request_id IS NOT NULL;
```

設計判断:
- **PK = `(conversation_id, sequence)`**: `event.sequence` が conversation
  単位の単調増加であるため 2 列で自然な dedup キーになる。SDK retry で
  同一 record が再送されても `INSERT OR IGNORE` で冪等。`prompt_id` を PK
  から外すことで、同一 seq に異なる `prompt_id` が来た場合も先着勝ちで
  dedup できる (defensive)
- **`body` column 無し**: body は `"claude_code.<event_name>"` の冗長
  文字列なので `event_name` で十分。dropped
- **`conversation_id` / `prompt_id` / `sequence` は NOT NULL**:
  欠けた record は ingest 時に warn drop。whitelist 外イベント drop と
  同じ policy
- **`request_id` のみ独立 column として promote**: trace 結合の主キー
  として頻繁に JOIN される。partial index で api_request 以外の NULL
  を物理スキップ
- **`idx_log_records_conv_prompt`**: turn 単位 GROUP BY のためのインデックス。
  `idx_log_records_conv_time` は sequence が単調増加であるため不要となり削除
- **`prompt` 本文 / `model` / token 系は attrs_json のまま**: 当面検索
  しないので promote 不要。必要になったら別 ADR
- **`event_name` に CHECK 制約は付けない**: whitelist 拡張時の毎回
  schema bump を避ける。妥当性は ingest 層で担保

### Schema rebuild policy

`HISTORY_DB_USER_VERSION` を 2 → 3 に bump。migration は実装せず、
`rm ~/.local/share/nas/history.db` を運用手順とする (既存 `store.ts:59`
方針踏襲)。

### Reader: trace_id ⇔ prompt_id は query 時に JS で照合

`log_records` も `spans` も `request_id` を持つ (logs は独立 column、
spans は `attrs_json` 内)。conversation 1 件分のデータは小さい (turn
数十オーダ) ので、reader は両方を取得後 JS で in-memory join する:

1. `SELECT * FROM log_records WHERE conversation_id = ?` で event 全件取得
2. `event_name = 'api_request'` 行から `request_id → prompt_id` の Map
3. spans 側の `claude_code.llm_request` の `request_id` を Map で引いて
   `trace_id → prompt_id` を確立
4. `event_name = 'user_prompt'` 行から `prompt_id → user_prompt text`
5. 合成して trace ごとに `userPromptText` を attach

denormalization (e.g. `traces.prompt_id` 列追加 / log_records への
trace_id 列追加 / 受信時 UPDATE) は採らない。spans と logs の到着順序
依存が出るのと、UI クエリの N が小さいので JS join のコストが問題に
ならないため。

### UI 表示

`ConversationDetailPage` の既存 Turn accordion (`trace_id` 単位) に
user_prompt 表示を足す:

- **Turn header (折りたたみ時)**: 1 行プレビュー (例: `Turn 1: OTELの
  テストです。* bash呼...`)。長さは UI で truncate
- **Turn body (展開時)**: prompt 全文を上部の独立ブロックに表示。span
  tree テーブルはその下

UI で表示しないが DB には保存するもの:
- `hook_execution_start/complete`: デバッグ用に DB に保存するが、turn
  画面には出さない (Hook 使ってない user のノイズになるため)
- `api_request`: トークン会計の安定経路として DB に持つが、UI 上は
  既存 span 由来の token 列で十分なので非表示

これらは将来別 commit で追加する余地があるが、本 ADR スコープでは
保存のみ。

## Consequences

- receiver は 2 シグナルを受理。`/v1/metrics` は依然不要
- Codex/Copilot への logs シグナル適用は別 commit:
  - Codex: argv に `-c otel.log_user_prompt=true` 追加
  - Copilot: env 候補を実機確認
- 実験用 dump (`~/.cache/nas/otlp-logs-dump/`) は production 経路ではない。
  本 ADR 実装に伴い receiver の `/v1/logs` ハンドラを生 dump から本 ingest
  に差し替えて削除する

## Rejected alternatives

- **logs を spans に統合**: 親子関係が span tree でなく prompt.id 平坦のため、
  `parent_span_id` の意味が壊れる
- **全 event 無差別 ingest**: `tool_decision` は bypass-permissions 下で
  無意味、`skill_activated` は span 重複。DB が膨れる割に UI 情報が増えない
- **trace の span attr `user_prompt` だけで済ませる**: 安定保証が無く
  Anthropic がいつでも消せる
- **`OTEL_LOG_RAW_API_BODIES=1` を有効化**: 容量大、PII 露出面拡大、当面不要
- **file exporter + tail 方式**: receiver は既に `/v1/traces` で立って
  おり、`/v1/logs` を足す方が漸進的・per-session lifecycle 整合
