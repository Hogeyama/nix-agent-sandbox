---
Status: Draft
Date: 2026-05-02
---

# ADR (Draft): gated-commit-loop telemetry ingest into history.db

## Context

`gated-commit-loop` skill は run 終了時に
`./.gated-commit-loop/<yyyymmddHHMMSS>-summary.jsonl` を吐く (skill 側
Step 5、Appendix にスキーマ定義済み)。これを `review-config.yml` の rule
チューニング (rule 単位のノイズ率 / critical 取り逃がし傾向の観察) に
使いたい。ローカル JSONL のままでは:

- 集計が ad-hoc grep / jq に閉じ、横串が回らない
- nas session (= DB 上の invocation) との対応が手動相関
- 複数 run 跨ぎの「rule X はノイズが多い」「rule Y は essential
  finding を取り逃がしがち」の観察が回らない

ADR 2026042901 で per-session OTLP receiver + SQLite `history.db` が入って
いる。OTEL spans / turn_events と同居させて、invocation 単位の view から
横串で見られる状態にする。

**本 ADR のスコープ**: ingest 経路 + DB schema + 最小 UI 表示。集計
ダッシュボードや rule 自動チューニングは out of scope。

## Decision

### 経路: skill が wrapper script で receiver に POST

skill の Step 5 末尾で、JSONL を書き出した直後に
`nas-emit-summary <path>` を呼ぶ。

- **wrapper の責務**: env (`NAS_TELEMETRY_ENDPOINT` 想定、receiver の
  base URL) を読み、curl で receiver に POST する薄い shell script。
  endpoint 未設定なら no-op 0 終了 (bare host で skill が動いても fall back
  する)
- **wrapper の配置**: nas が container に bind-mount する既存 helper
  (`local-proxy.mjs` 等) と同じ枠組みで `/usr/local/bin/nas-emit-summary`
  として PATH に乗せる
- **skill 側の検出**: `command -v nas-emit-summary` が当たれば呼ぶ、無ければ
  スキップ。**skill が nas の存在を assume しない**。これにより skill は
  nas optional のまま「nas があれば連携する」関係を保つ
- **POST 先**: 既存の per-session OTLP receiver process に endpoint を 1 本
  追加する (例: `POST /v1/nas/run-summary`)。OTLP 本体 (`/v1/traces`) と
  同居。container → host 配線は ADR 2026042901 の forward-port relay を
  そのまま再利用
- **wire format**: 1 リクエスト = 1 ファイル content。raw JSONL body を
  `Content-Type: application/x-ndjson` で送る。受信側は行単位 parse

### 識別子: 既存の `NAS_SESSION_ID` を流用

env は新設しない。既存の `NAS_SESSION_ID` を skill が読み、
`meta.nas_session_id` field として JSONL に含める。

DB 上はこの値を `invocations.id` と JOIN する。**用語の不整合 (agent
session ≠ DB 上の "invocation" を nas session と呼んでいる) は別 ADR で
整理**。本 ADR では既存命名のまま進める。

skill 側変更 (本 ADR と同 PR で実施):

- `gated-commit-loop/SKILL.md` Appendix の `meta` イベント定義に
  `nas_session_id?: string` を追加
- Step 5.4 (出力先準備) または Step 5.5 (JSONL 書き出し) の手順に
  「`NAS_SESSION_ID` env を読んで `meta` に詰める」を追加
- Step 5.6 (報告) の前に「wrapper があれば `nas-emit-summary` を呼ぶ」を
  追加。失敗してもログ報告のみで Step 5 全体を失敗扱いにしない (skill の
  本体仕事は JSONL を書いた時点で完了している)

### Schema: 専用 `gcl_*` テーブル群

`PRAGMA user_version` を 1 上げる。次の 4 テーブルを追加:

```sql
CREATE TABLE gcl_runs (
  run_id          TEXT PRIMARY KEY,    -- skill 側 meta.run_id
  invocation_id   TEXT REFERENCES invocations(id),  -- meta.nas_session_id
  cwd             TEXT,
  user_request    TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  source_path     TEXT NOT NULL,       -- 元 JSONL のパス (デバッグ用)
  ingested_at     TEXT NOT NULL
);

CREATE TABLE gcl_plan_iters (
  run_id           TEXT NOT NULL REFERENCES gcl_runs(run_id),
  iter             INTEGER NOT NULL,
  reviewer_verdict TEXT NOT NULL,      -- approve | reject
  reviewer_reason  TEXT,
  user_verdict     TEXT,                -- approve | revise | abort | NULL
  user_comment     TEXT,
  PRIMARY KEY (run_id, iter)
);

CREATE TABLE gcl_commits (
  run_id          TEXT NOT NULL REFERENCES gcl_runs(run_id),
  seq             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  hash            TEXT,                -- review 落ち / blocked で未到達なら NULL
  review_iters    INTEGER NOT NULL,
  implementer_blocked_count INTEGER NOT NULL DEFAULT 0,
  rating          TEXT,                -- good | mixed | bad | NULL
  rating_comment  TEXT,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE gcl_findings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES gcl_runs(run_id),
  commit_seq      INTEGER NOT NULL,
  review_iter     INTEGER NOT NULL,
  rule            TEXT NOT NULL,
  severity        TEXT NOT NULL,       -- critical | warning | info
  file            TEXT,                -- "path:line" 連結
  message         TEXT NOT NULL,
  resolution      TEXT NOT NULL,       -- fixed | ignored | dropped
  label           TEXT,                -- essential | noise | borderline | NULL
  label_comment   TEXT,
  FOREIGN KEY (run_id, commit_seq) REFERENCES gcl_commits(run_id, seq)
);

CREATE INDEX idx_gcl_runs_invocation ON gcl_runs(invocation_id);
CREATE INDEX idx_gcl_findings_run    ON gcl_findings(run_id);
CREATE INDEX idx_gcl_findings_rule   ON gcl_findings(rule);
```

table prefix `gcl_` は「この skill 由来」と分かるようにするため。同種
telemetry を吐く skill が現れたら、その時 schema を generalize する (今は
YAGNI)。

### Ingest の冪等性

- `gcl_runs.run_id` を PK にして `INSERT OR IGNORE` で受ける (同じ JSONL を
  再 POST しても DB が変わらない)
- skill 側保証: `run_id` は skill が UUID v4 等で生成、run 内でユニーク
- wrapper は POST 200 OK 後、source JSONL を `*.jsonl.ingested` に rename
  して再送防止。rename 失敗は warning に留め、fatal 化しない (DB 側で
  重複は防げる)

### UI: invocation detail page に "Run reports" セクション

ADR 2026042901 で導入した invocation detail page に新セクションを足す。

- **セクション名は "Run reports"** (skill 名 / "gated-commit-loop" / "GCL"
  は UI に出さない)。将来別 skill が同型 telemetry を吐いた場合に同じ
  セクションに並ぶことを想定した汎用ラベル
- 表示単位は run。各 run について:
  - ヘッダ: ユーザー依頼 (要約) / commit 数 / replan 回数 / started〜finished
  - 展開で commit 一覧 (title / hash / review iters / rating)
  - さらに展開で finding 一覧 (rule / severity / file / resolution / label)
- SSE は既存 `/api/history/invocation/:id/events` の payload に
  `runReports?: RunReportsSnapshot` を載せる (新 endpoint を分けない)
- **conversation detail への露出は今回見送り**。1 invocation : N
  conversations (subagent / `/new`) のとき run をどの conversation に
  紐付けるかが恣意的になる。invocation 軸の方が自然

**個別 trace span との紐付けは今回やらない**。orchestrator + subagent が
複数 conversation/trace を生み、commit 単位の review→implement→commit
cycle を OTEL 側のどの trace に紐付けるかが skill 側で取れない (Claude
Code が subagent の conversation_id を skill API に露出していない)。run
全体を invocation に紐付けるところで止める。trace との視覚的な紐付けは
ADR を改めて切ってから取り組む。

## Open questions

- wrapper の言語 / 配置詳細: nas の既存 helper (`local-proxy.mjs` 等) と
  同じ仕組みに乗せるか別の置き方をするかは実装で決める
- bare host 運用での skill 動作: env / wrapper どちらが欠けても skill が
  壊れないテストを実装側で入れる
- `gcl_findings.file` の形式: SKILL.md Appendix では `file:line` 連結。
  SQL で line を抜きたいケースが出てきたら schema split を検討
- "Run reports" の generic 化タイミング: 2 番目の producer が現れた時点で
  schema / UI を generalize する。前倒ししない
- "nas session" / "invocation" の用語整理: 本 ADR の範囲外。別 ADR で

## Rejected alternatives

- **per-session inotify watcher** で `.gated-commit-loop/` を tail:
  ran-end 1 イベントの ingest に常駐 watcher は overkill
- **`nas hook` 経由で ingest**: hook は agent → nas の制御フロー
  (PreToolUse 等) のための薄いラッパで、データ ingest と責務が混じる
- **skill が nas を強く assume**: skill が `nas-emit-summary` の存在を
  前提化すると bare host で動かなくなる。optional な関係を保つ
- **新規 env (`NAS_INVOCATION_ID` 等) を追加**: 既存 `NAS_SESSION_ID` で
  足りる。env 名空間を増やさない
- **conversation detail にも Run reports を露出**: 紐付けが恣意的に
  なる。invocation 軸に絞る
- **schema を最初から generic 化** (`run_reports` / `run_findings`):
  単一 producer の段階で abstraction を入れる利点が薄い。YAGNI
- **finding を `turn_events.payload_json` に流す**: rule 単位の集計が
  JSON 関数経由になり実用性が落ちる
- **専用ページを新設**: 既存 invocation detail に同居させた方がコンテキスト
  が切れない
