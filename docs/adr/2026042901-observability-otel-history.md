---
Status: Draft
Date: 2026-05-01
---

# ADR (Draft): observability — per-session OTEL receiver + SQLite history store

## Context

nas は harness として container 隔離・network 制御・hostexec 委譲・worktree
管理まで一通り揃ったが、「何が起きたか後から追える」観測性レイヤが無い。
session JSON / approval registry に断片が残るのみで、

- どれだけ自律走行したか (user-turn 待ちで止まらず走った時間)
- session の総 wall time / agent-turn 比率
- token 消費量・コスト
- tool 呼び出し回数

が横串で見えない。これらが見えないと profile tuning / policy 調整 / agent
比較といった次の harness 機能の意思決定材料が出ない。

harness を進める方向として 4 つを比較した:

- **観測性**: session の挙動・コスト・自律走行時間を構造化保存し、UI / CLI
  から横串で見られるようにする
- **並列・マルチ agent 運用**: 複数 worktree の状態俯瞰、同タスクを
  Claude/Copilot/Codex で並列実行して比較する agent matrix、agent → sub-agent
  委譲
- **成果物パイプライン**: worktree teardown の自動 PR 化、自動 self-check
  (lint / typecheck / test) 後の再実行、スケジュール / headless 実行
- **policy as code**: 承認ログから rule 候補を生成、per-session の
  rate-limit / kill-switch、secret 露出の sub-task scope 化

どれも「nas が今どう走ったか」の数字に依存するため、観測性が他の前提になる。
よって **観測性を最初に着手**。さらに観測性の中でも、

- approval spam (network / hostexec の pending 多発) は現状の運用で痛みが
  出ていない
- 一方で会社の Copilot CLI が従量課金になり Claude Code よりも Copilot
  側のコスト把握の重要度が高い

という運用都合から、**autonomy duration + token usage を主指標とする** (承認
イベントの構造化保存は本 ADR の対象外)。

## Decision

### スコープ判断

- 計測対象: autonomy run length / session wall time / token (in / out / cache
  read / cache write) / model 別コスト換算 / tool 呼び出し
- approval イベントの構造化保存は **やらない** (現状 spam が起きていない)
- 会話履歴 / prompt content のキャプチャは **本 ADR の scope 外** (別 commit で
  追加。最初は metric / span 構造のみ)
- 表示面 (reader) は **UI daemon のみ**。CLI の history サブコマンドは持たない

### データソース: OTEL

各 agent が OpenTelemetry をサポートしているので、agent 横断の単一経路に
できる。

- **Copilot CLI**: `COPILOT_OTEL_ENABLED=true` ほか env で有効化。spans は
  `invoke_agent` / `chat` / `execute_tool` の階層 (GenAI Semantic Conventions
  準拠)。OTLP / 独自 file exporter (`COPILOT_OTEL_FILE_EXPORTER_PATH`) 両対応
- **Claude Code**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` で metrics / log events、
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` で traces (beta)。span 名は
  `claude_code.interaction` / `claude_code.llm_request` / `claude_code.tool`
  等の独自命名
- **OpenAI Codex CLI**: env ではなく `-c` config override で OTLP/HTTP JSON
  traces を有効化。nas は argv に
  `-c 'otel.trace_exporter={otlp-http={endpoint="http://127.0.0.1:<port>/v1/traces",protocol="json"}}'`
  相当を追加する。span 名は `session_task.*` / `mcp.tools.call` /
  `codex.turn.token_usage` / `model_client.stream_responses` 等の独自命名

→ **agent 横断スキーマは GenAI semconv に寄せる**。Claude 側は nas が mapper を
1 枚噛ませて正規化する (`claude_code.llm_request` → `chat`、`claude_code.tool`
→ `execute_tool` 等)。Codex 側も nas が mapper を噛ませて
`session_task.turn` → `invoke_agent`、`mcp.tools.call` → `execute_tool`、
response / stream / token usage spans → `chat` へ正規化する。

### 受信方式: per-session OTLP receiver process

OTEL file exporter を `$XDG_STATE_HOME/nas/sessions/<id>/otel.jsonl` に
吐かせて inotify で tail する案もあったが、

- inotify を入れるくらいなら server を立てる方が単純
- nas には既に **per-session host process パターン** (auth-router /
  hostexec-broker / network broker) が確立している
- UI daemon に同居させると `ui.enable: false` 運用との整合や
  observability ↔ UI lifecycle の絡みが面倒

ので、**per-session OTLP receiver process** を新規導入する。lifecycle は
session に張り付き、stages の scoped finalizer に乗せる。

```
session N (proxy stage で隔離 network)
  ├── agent container
  │     └── OTLP exporter → 127.0.0.1:<port>
  │           └─→ local-proxy → UDS bind-mount ──┐
  ├── auth-router (UDS)                           │
  ├── hostexec-broker (UDS)                       │
  ├── forward-port relay (UDS listener)  ◀───────┤
  │     └─→ host 127.0.0.1:<port>                │
  └── otel-receiver (host 127.0.0.1:<port>)  ◀──┘  ←── 新規 (per-session host process)
        └─→ history.db (SQLite WAL, 共有)

reader: UI daemon  ←── history.db を read-only で参照
```

### Container → host 配線: forward-port relay 経由

前提として、agent container は **proxy stage によって session-scoped の
隔離 network に入る運用が常**。素の bridge network に直接乗せる経路は
今後削除予定 (本 ADR の範囲では存在しないものとして扱う)。隔離 network
下では host への default route が無いため、ADR 2026042802 で導入した
per-session UDS forward-port relay が host 到達の唯一の経路となる:

- host: receiver は `127.0.0.1:<port>` で listen (port は session ごと
  に空きを取る)
- nas が `forwardPorts` に当該 port を session-scoped で追加。既存の
  relay が **container `127.0.0.1:<port>` → UDS → host `127.0.0.1:<port>`**
  を肩代わりする
- container 側 `local-proxy.mjs` が UDS dial を受け持つ
- Claude/Copilot agent env:
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>`、
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`
- Codex argv config override:
  `codex -c 'otel.trace_exporter={otlp-http={endpoint="http://127.0.0.1:<port>/v1/traces",protocol="json"}}' ...`
- envoy allowlist 例外 / broker loopback deny 例外は **不要** (経路に
  envoy / broker が挟まらない)
- Node OTLP HTTP exporter の `unix:` 非対応問題は agent からは見えない
  (container 視点では普通の TCP loopback)
- profile が静的に宣言する `forwardPorts` とは別に、observability 由来の
  動的 entry を 1 つ足す形。observability disabled 時は entry を足さず
  relay 側 `ports=[]` no-op fast path に乗せる

### Storage: SQLite (`$XDG_DATA_HOME/nas/history.db`)

- single writer 候補 = receiver と nas hook の 2 系統。reader は UI daemon
- WAL モード。N session が同時に書いても OTEL events は hot ではない
  (1 turn あたり span 数個〜十数個) ので contention は実用上無視
- per-user 1 ファイル。session 終了後も残し、横断ビューが単純 SQL で書ける
- `PRAGMA user_version` で schema 版を管理。open 時に不一致なら **migration を
  試みず refuse する** (reader / writer どちらも)。既存ファイルが古いときの
  運用は手動 `rm` → 次回 writer 起動時に再生成

### データモデル: Invocation / Conversation / Trace の三層

「実行」と「会話」を別 identity として持つ。両者は **trace を junction として
M:N で結合**する。手元 DB の観測上、

- 1 invocation が複数 conversation を生むケース (`/new` / subagent / 内部
  spawn) は実在し、6 trace で 5 conversation のような分散も観測される
- 1 conversation が複数 invocation から見えるケース (`--resume` 連発) も
  実在する
- 各 OTLP trace の `agent_session_id` は (今のところ) **trace 内で一意**
  (DB を `GROUP BY trace_id` で検証済み)。trace を junction にして
  invocation × conversation を結ぶ前提が成立する

```sql
-- nas が握る側。CLI 1 起動 = 1 行
CREATE TABLE invocations (
  id              TEXT PRIMARY KEY,    -- nas-issued sess_<hex>
  profile         TEXT,
  agent           TEXT,
  worktree_path   TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  exit_reason     TEXT
);

-- agent が握る側。--resume 跨ぎで持続。/new で別 row が生まれる
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,    -- agent-issued (Claude session.id /
                                       -- Copilot gen_ai.conversation.id /
                                       -- Codex conversation.id or thread.id)
  agent           TEXT,                -- claude / copilot / codex
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

-- Invocation × Conversation の junction
CREATE TABLE traces (
  trace_id        TEXT PRIMARY KEY,
  invocation_id   TEXT NOT NULL REFERENCES invocations(id),
  conversation_id TEXT REFERENCES conversations(id),  -- 解決まで NULL
  started_at      TEXT NOT NULL,
  ended_at        TEXT
);

CREATE TABLE spans (
  span_id         TEXT PRIMARY KEY,
  parent_span_id  TEXT,
  trace_id        TEXT NOT NULL REFERENCES traces(trace_id),
  span_name       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  model           TEXT,
  in_tok          INTEGER, out_tok INTEGER,
  cache_r         INTEGER, cache_w INTEGER,
  duration_ms     INTEGER,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  attrs_json      TEXT NOT NULL DEFAULT '{}'
);

-- nas hook 由来。invocation 必須、conversation は hook payload から直に取る
CREATE TABLE turn_events (
  invocation_id   TEXT NOT NULL REFERENCES invocations(id),
  conversation_id TEXT REFERENCES conversations(id),
  ts              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_traces_invocation       ON traces(invocation_id);
CREATE INDEX idx_traces_conversation     ON traces(conversation_id);
CREATE INDEX idx_spans_trace             ON spans(trace_id);
CREATE INDEX idx_turn_events_invocation  ON turn_events(invocation_id, ts);
CREATE INDEX idx_turn_events_conversation ON turn_events(conversation_id, ts);
CREATE INDEX idx_invocations_started     ON invocations(started_at DESC);
CREATE INDEX idx_conversations_lastseen  ON conversations(last_seen_at DESC);
```

設計上の含意:

- 「invocation は補助、conversation が主軸」が物理に表れる: conversation は
  独立 PK を持ち、metadata の置き場ができる (rename / tag / 単価表 binding を
  将来追加するならここ)
- conversation 配下の集計は `traces` を 1 hop 経由する: span aggregate は
  `JOIN traces ON spans.trace_id = traces.trace_id WHERE traces.conversation_id = ?`、
  turn_events は `WHERE turn_events.conversation_id = ?` で直撃
- subagent / `/new` ケース: invocation A の trace 群がそれぞれ別 conversation を
  指す。`runs.agent_session_id` 単一列での情報損失が起きない
- `--resume` ケース: 1 conversation の `last_seen_at` が複数 invocation を
  跨いで前進する。conversation 単位 list は `last_seen_at DESC` で時系列に並ぶ
- OTLP-less invocation (hook のみが書いた行) は trace 行ゼロで成立。
  conversation には現れない

### Span classification: `gen_ai.operation.name` 優先で `kind` を決める

`spans.kind` は次の固定優先順で決まる。最初にマッチした layer が採用される:

1. `attrs["gen_ai.operation.name"]` が `chat` / `execute_tool` / `invoke_agent`
   のいずれかであればそのまま採用
2. span.name が `chat` / `execute_tool` / `invoke_agent` に厳密一致。chat に
   ついては OpenLLMetry semconv 系の variant (`gen_ai.client.operation` 等の
   名前または同 prefix) もここで吸収
3. Claude Code の vendor span 名:
   - `claude_code.llm_request` → `chat`
   - `claude_code.tool` 完全一致 または `claude_code.tool.` で始まる name
     → `execute_tool`
4. Codex CLI の vendor span 名:
   - `session_task.turn` / `session_task.review` / `session_task.compact`
     → `invoke_agent`
   - `session_task.user_shell` / `mcp.tools.call` → `execute_tool`
   - `codex.turn.token_usage` / `codex.response` / `codex.responses` /
     `model_client.stream_responses` /
     `model_client.stream_responses_websocket` /
     `responses.stream_request` /
     `responses_websocket.stream_request` → `chat`
5. span.name の **空白区切り prefix** (Copilot CLI の `<op> <subject>` 形):
   - `chat <model>` → `chat`
   - `execute_tool <name>` → `execute_tool`
   - `invoke_agent <name>` → `invoke_agent`
6. `attrs["gen_ai.system"]` が文字列で存在 → `chat`
7. いずれにも当たらなければ `other`

Copilot CLI は全 span に `gen_ai.operation.name` を載せて出すため、Copilot
由来の span は常に layer 1 で確定する。Claude Code は vendor 名で出る span が
layer 3 に乗り、`chat` / `execute_tool` への正規化が掛かる。Codex CLI は
vendor 名で出る span が layer 4 に乗り、turn / review / compact を
`invoke_agent`、shell / MCP tool call を `execute_tool`、response / stream /
token usage を `chat` に正規化する。

Token usage は `spans` の token 列へ promotion するときに二重計上を避ける。
Codex trace 内では `codex.turn.token_usage` span を最優先し、その span が無い
場合だけ response / stream span の token を採用し、それも無い場合に限って
`session_task.turn` 上の turn-only usage を採用する。

### Trace と conversation 紐付けの解決ルール

`traces.conversation_id` は **trace_id 単位で 1 度だけ** 解決する:

- 元データは agent 種別ごとに異なる span attribute:
  - Copilot CLI: `gen_ai.conversation.id`
  - Claude Code: `session.id` (resource attribute 側の `nas.session.id` とは
    別物。span attribute として乗ってくる方)
  - Codex CLI: `conversation.id`、fallback として `thread.id`
- `gen_ai.conversation.id` は **sparse**: Copilot は `chat` / `invoke_agent`
  span にしか載せず、`execute_tool` span には載らない。よって receiver は
  span 単位ではなく **OTLP `trace_id` 単位で resolve** する
- trace 全体での優先順は `gen_ai.conversation.id`、`session.id`、Codex
  `conversation.id`、Codex `thread.id`。まず trace 内の全 span を入力順に
  走査して `gen_ai.conversation.id` または `session.id` の最初の非空値を探し、
  見つからない場合に trace 内の全 span を再走査して Codex `conversation.id`
  または `thread.id` の最初の非空値を採用する
- 1 つの span が複数の属性を持つ場合も同じ優先順を適用する。
  空文字は無いものとして扱う
- batch を跨いだ更新は `traces.conversation_id` の null / 既存値を上書き
  しない (`COALESCE(excluded.conversation_id, traces.conversation_id)`)。
  非 null の incoming 値は最初の 1 度だけ書かれる

resolve した値で `conversations` 行を upsert (`first_seen_at` は最古、
`last_seen_at` は最新で UPDATE)。

### turn_events への conversation_id 付与: hook payload から直接取る

`nas hook` は Claude/Copilot の hook stdin payload から conversation id を
取得できる:

- Claude Code: 全 hook イベントの payload に `session_id` field
- Copilot CLI: `sessionId` field (camelCase)

この値を読み出して `turn_events.conversation_id` に直接書く。OTLP receiver の
trace 解決を待つ必要は無い。subagent ケースについても、現状の観測では
**subagent の hook イベントは parent の sessionId で発火する** (Copilot の
"agent finished" system_notification も parent session に乗る) ため、
turn_events は常に「parent conversation の turn」として帰属する。subagent 内部
の LLM call / tool call は OTLP 経由で **subagent 自身の conversation_id** で
記録され、両者は自然に分離される。

`conversations` 行が hook 観測時点で未存在の場合に備え、hook も
`upsertConversation` を呼ぶ (agent 名は null のまま、後続 OTLP receiver で
COALESCE 上書き)。

`session_id` / `sessionId` のいずれもが payload に無い場合は `conversation_id`
は NULL のまま挿入。retroactive backfill ロジックは持たない (この
edge case は現実にほぼ起きないため、複雑性を入れない)。

### UI reader: SSE 3 endpoint + 5 秒 poll-and-diff

reader は UI daemon に集約する (CLI 提供しない方針と同根)。frontend は SSE のみで
購読し、REST history endpoint も REST history client も持たない。endpoint は
表示単位ごとに 3 本に分ける:

```
GET /api/history/conversations/events            ← list snapshot stream
GET /api/history/conversation/:id/events         ← conversation detail stream
GET /api/history/invocation/:id/events           ← invocation detail stream
```

各 endpoint は per-connection state を持って **5 秒間隔** で history db を
SELECT し、前回送出値との JSON 比較で **diff があれば 1 event** 送出する
(既存 `src/ui/routes/sse.ts` / `sse_diff.ts` の poll-and-diff パターンと同形)。
event 名 (`history:list` / `history:conversation` / `history:invocation` /
`history:not-found`) は const tuple で wire 名を中央集権化し、frontend と
同じ識別子を import する。

5 秒は OTEL SDK の batch flush 周期 (数秒) と揃える値で、これより短くしても
新しいデータが来ない。`bun:sqlite` の readonly handle は WAL writer を
blocking しないので、複数 SSE connection が並列 SELECT しても writer 側 (per-
session OTLP receiver / `nas hook`) は影響を受けない。

frontend は page mount で対応する EventSource を 1 本開き、unmount で close
する (per-page subscription)。ブラウザの 6-connection-per-origin 制限下でも
list と detail を同時に開かない route 構造になっており、global `/events`
(既存の sidecars / audit / pending 用) と合わせて常時 2 本までで収まる。

### Resource attributes: nas 由来の identity を全 span に乗せる

Claude/Copilot は env で resource attributes を渡す:

```
OTEL_RESOURCE_ATTRIBUTES=nas.session.id=<id>,nas.profile=<p>,nas.agent=<claude|copilot>
```

Codex は `otel.trace_exporter` config override で exporter endpoint / protocol を
指定し、resource attribute を exporter config としては渡さない。receiver は
per-session listener が保持する metadata を fallback として使い、payload の
resource attributes に `nas.session.id` / `nas.profile` / `nas.agent` が無い
場合だけ補う。payload が同名 metadata を持つ場合は payload の値を上書きしない。
この fallback により Codex の span も `nas.agent=codex` として保存される。

`nas.session.id` は `invocations.id` の値 (= nas-issued sess_<hex>) を入れる。
receiver はこれを使って **どの invocation に紐付ける trace か** を判定する。
agent が emit する `session.id` / `gen_ai.conversation.id` / `conversation.id` /
`thread.id` とは独立。

### 永続化のタイミング

receiver は HTTP で受けた時点で SQLite にバッチ insert (transaction 単位)。
file exporter 経路を取らないので「runtime tmpfs に buffer して session 終了
時に flush」という議論は発生しない。クラッシュ時に nas / receiver が
落ちている間の span は OTEL SDK の bounded queue で吸収され、それを越えた
ら drop。観測性として 100% は要らないので許容する。

## Open questions

- **会話履歴キャプチャの扱い**:
  - Claude Code: `OTEL_LOG_RAW_API_BODIES=1` (or `file:<dir>`) で API
    request/response JSON を生で取れる (extended-thinking は redact 済み)
  - Copilot CLI: `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` で
    span attribute に prompt / response / tool args / tool results が乗る
  - profile に `observability.capture-content: true` フラグを置いて、明示的
    opt-in 時だけ env を inject する設計が安全
  - サイズが無視できない (API body 数十 KB / turn) ので SQLite 直 insert は
    避け、本文だけ別テーブルか per-session blob ファイルに分離
- **Claude → GenAI semconv mapper の網羅度**: 最低限の `chat` /
  `execute_tool` 対応で始め、Claude 独自の `claude_code.tool.blocked_on_user`
  等は `attrs_json` に逃がす (失われない、ただし横串クエリには出ない)
- **OTEL export interval**: short-lived task で flush 漏れしないよう
  `OTEL_METRIC_EXPORT_INTERVAL=1000` 等で短く倒すか、receiver 側 graceful
  shutdown で待つか。実装時に決める
- **Cost 換算**: 単価テーブルが未実装。生 token を保存しているので view 側で
  agent 別単価表を参照する設計だが、テーブル定義 / 通貨単位 / Copilot の
  premium-request 単位との整合は別途検討
- **`turn` 概念の materialize**: 現状 turn は turn_events の start/stop
  pulse の時間窓でしか定義されない。subagent には適用できないため `turns`
  テーブルは作らず、UI 側で必要なら turn_events を ASC walk して span を
  bucket するロジックで対応する

## Rejected alternatives

- **観測性を後回しにして並列運用 / 成果物パイプライン / policy as code を
  先に着手**: いずれも「nas が今どう走ったか」の数字が見えることを前提と
  する。観測性を後回しにすると効果測定の根拠が出ない
- **approval イベントの構造化保存を最初の指標に**: 現状 approval spam が
  運用上の痛みになっていない。autonomy / token の方が運用都合 (Copilot
  従量課金) と直接噛み合う
- **ストレージを JSONL append-only にして横断クエリは後で SQLite に集約**:
  最初から SQLite で良い。横断クエリが SQL 1 発で済むメリットが大きく、
  format 変換コストを後出しにする利点が薄い
- **OTEL を使わず agent transcript を parser で吸い上げる**:
  `~/.claude/projects/<ws>/<sid>.jsonl` 等を tail する案。agent 種別ごとに
  parser を持つことになり、フォーマット変更にも弱い。OTEL は各 agent
  公式サポートなので素直
- **Envoy / proxy 層で response header を抜く**: SSE / streaming で粒度が
  荒く、ヘッダ仕様変更に弱い。span 構造が取れないので autonomy 計測には
  使えない
- **OTEL file exporter に吐かせて inotify で tail**: server を立てる方が
  単純。inotify + recovery + JSONL cleanup の運用面倒も避けられる
- **container → host を `host.docker.internal:<port>` (docker bridge) で
  叩く**: ADR 2026042802 で forward-port を UDS bind-mount に倒した動機
  (host サービスを `127.0.0.1` bind のままに保つ) と真っ向から衝突する。
  receiver listener を `0.0.0.0` ないし bridge IP に出す regression を
  発生させ、broker loopback deny にも session-scoped 例外を増やす羽目に
  なる。forward-port relay を 1 entry 流用するだけで TCP loopback の
  agent 側体験は維持できるので、わざわざ別経路を引かない
- **container 側に TCP→UDS shim を独自に入れる**: forward-port relay が
  既に同じ抽象 (per-session UDS bind-mount + container 内 TCP listener) を
  提供している。OTEL のためにもう 1 枚 shim を建てるのは規約の重複
- **UI daemon に OTLP receiver を同居**: `ui.enable: false` 運用との整合
  が必要になり、UI lifecycle (idle-timeout / auto-spawn) と observability
  lifecycle が結合する。per-session pattern が既にある以上、そちらに
  揃える方が筋
- **per-user 共有の receiver daemon を新設**: UI daemon 同居案と本質的に
  同じ問題 (lifecycle 設計の二重持ち)。session に張り付く方が stages
  規約に乗せやすい
- **ingester 段階で USD コスト換算を `cost_usd` カラムに固定値で書く**:
  Copilot の課金単位 (premium request) と Anthropic の単価モデルが噛み
  合わない。生 token を保存し、view 側で agent 別単価テーブル参照に倒す
- **runtimeDir に file exporter を吐かせて session 終了時に flush**:
  `$XDG_RUNTIME_DIR` は tmpfs で logout / reboot で飛ぶ。途中 crash 時に
  buffer ごと消える。state dir に置けば回避できるが、そもそも server
  方式で file 経路自体を持たない方が単純
- **`runs` テーブル単一軸で agent_session_id を列として持つ旧スキーマ**:
  `runs.agent_session_id` 単一列だと 1 invocation : N conversations
  (subagent / `/new`) を表現できず、最初に観測された 1 値しか残らない。
  手元 DB で `sess_b96e28303ae6` が 6 trace × 5 conversation を持つことが
  実観測されており、情報損失が現実に発生する
- **`turn_events.conversation_id` を後から OTLP 受信で backfill**:
  Claude/Copilot は hook payload に session id field を提供しているので、
  書き手側で直接埋められる。retroactive UPDATE 経路を持つほうが余計に複雑
- **CLI (`nas history`) を提供する**: 表示面は UI daemon に集約する。CLI
  history は実装ライン (vocabulary / 出力レイアウト / test) を増やす割に、
  UI と機能が重複する。必要が再燃したら view 用 SQL を 1 つ追加するだけで
  足る位置に DB が居る
- **UI reader を REST endpoint で出す / REST + SSE 両建て**: reader を SSE
  のみに絞ると frontend 側のキャッシュ TTL / LRU / stale-response 制御が消え、
  「常に live」一本で UX を組める。REST を併設すると同じ data に 2 経路でき、
  整合タイミングを reader 内で持つ責務が増える。CLI を提供しない方針と同様、
  reader 経路を 1 本に絞ることで仕様面が単純になる
- **UI reader を 1 本の SSE endpoint + broker fan-out で多重化**: 通信路は
  1 本で済むが endpoint 内に subscription multiplexer / per-tab filter を
  抱えることになる。表示単位ごとに endpoint を分ける案 (本 ADR 採用) は
  per-connection state が独立で per-page lifecycle と整合し、既存
  `src/ui/routes/sse.ts` / `sse_diff.ts` の pattern を踏襲できる。fan-out の
  必要性は同時購読数の規模が見えてからで遅くない
- **SSE polling 間隔を 1 秒**: OTEL SDK の batch flush 周期が数秒なので、
  1 秒で SELECT を回しても新しい行は来ない。SQLite に対する空 SELECT 負荷
  だけ 5 倍になる。5 秒に揃える方が batch flush と同期して取れる
