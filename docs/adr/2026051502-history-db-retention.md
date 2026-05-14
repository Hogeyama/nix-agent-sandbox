---
Status: Accepted
Date: 2026-05-15
---

# ADR: history.db OTEL レコードの保存期間 (retention) 機構

## Context

ADR 2026042901 で導入された history.db は、OTLP `/v1/traces` 受理 (spans /
traces) と ADR 2026051301 で足された `/v1/logs` 受理 (log_records) を通じて、
session の挙動を継続的に蓄積する store になった。蓄積されるレコードのうち
いくつかはセンシティブな本文を含む:

- `log_records` の `user_prompt` event は user prompt の本文をそのまま持つ
  (ADR 2026051501 で summary derive ソースとして安定化された経路と同じ)
- `OTEL_LOG_TOOL_CONTENT=1` 下では `tool.output` event に tool の入出力本文
  が乗り、`log_records` に保存される
- spans 側にも `claude_code.user_prompt` 等の event を `attrs_json` に
  畳んで保存している

これに対し、既存実装は無期限保管である。「何を書くか」は ADR 2026042901 と
ADR 2026051301 で決めたが、「いつ消すか」は未決だった。実運用上、

- プライバシー: 過去 session の prompt 本文・tool 出力本文が長期に残る
- ディスク容量: log_records の単一行は数 KB オーダだが session 数 × turn 数
  で積算する

の 2 点が時間と共に痛みになる。利用者は通常 1 nas プロセス = 1 session で
立ち上げ、history.db 自体は長期に手元保有するが、過去 session の中身まで
残し続けたい要件は無い。よって retention 機構を入れる。

## Decision

### 設定: `observability.retention` (duration 文字列)

config から duration 文字列で受ける。受理形式は `<N><s|m|h|d|w>` (例:
`30d`, `2w`, `48h`)。schema 段で秒に正規化し、`ObservabilityConfig.retention`
は `number | null` (秒、`null` = 無期限保管 = default) とする。

下限 1h (3600s) を schema 段で強制する。これより小さい値は schema error と
して reject。稼働中の自分自身の session が retention で消える事故を避ける
ためのガード。

### 削除単位は invocation

削除起点は `invocations.started_at < cutoff` を満たす invocation 群。cutoff
は `now - retentionSeconds` の ISO 8601 文字列。`foreign_keys=ON` 下での
子→親→孤立の順に DELETE を 1 トランザクションで発行する:

1. 対象 invocation 群に紐付く trace の `log_records`
2. 対象 invocation 群に紐付く `spans`
3. 対象 invocation 群に紐付く `traces`
4. 対象 `invocations`
5. orphan `conversations` (残存 trace から参照されず、かつ
   `last_seen_at < cutoff`)

単一 tx で実行し、失敗時は SQLite が自動 rollback する。`PRAGMA user_version`
は変更せず (= HISTORY_DB_USER_VERSION=4 据え置き)、DDL も変えない。retention
は migration step を持たない。

### 発火点: writer-mode open の 2 経路

writer-mode `openHistoryDb` を実行するのは現状 2 経路 (`recordInvocationStart`
と `runObservability` Stage) のみで、retention 起動はこの両方で行う。reader
経路では発火しない (writer-only)。

### プロセス内 in-memory throttle

同一 dbPath について最低 1 時間に 1 回しか実 DELETE を走らせない。プロセス
内 Map で `dbPath → lastRunAt` を保持する。throttle の粒度はプロセス単位で、
別プロセスは共有しない (= プロセス起動ごとに最大 1 回走る)。

### 失敗は best-effort

retention が throw した場合は warn ログのみ出して握り潰す。agent run / 
observability stage の進行は止めない。これは既存の writer open 経路で
採っている best-effort 方針 (ADR 2026042901, 2026051401) を踏襲したもの。

## Alternatives considered

### vacuum / 物理シュリンクまで踏み込む

論理削除のあとに `VACUUM` を走らせて WAL を回収する案。`VACUUM` は他 writer
を長時間ブロックする可能性があり、retention の主目的 (プライバシー保護)
からも外れる。物理 size は運用上 `VACUUM` を手動で叩けば回収できるため、
本決定の scope 外とする。

### cron / 外部スケジューラに寄せる

OS の cron や別プロセスから定期的に prune をキックする案。設定の単一ソース
を nas config に寄せ、nas CLI 外で history.db を触らせない方針 (各種 ADR で
一貫している運用前提) に反する。却下。

### conversation 単位 / agent 単位の細粒度 retention

「Claude セッションは 30 日、Copilot は 7 日」のような細粒度の retention
を持つ案。設計複雑度が retention の主目的に対して過大で、初期版に乗せる
理由が無い。invocation 起点の単一しきい値で十分。

### migration で `ON DELETE CASCADE` を張る

DDL で cascade を張れば DELETE 順序を意識せず invocation を消すだけで子が
落ちる。ただし既存 schema の `FOREIGN KEY` 定義を書き換える migration が
必要で、ADR 2026051401 の forward-only 方針 (既存 step は immutable、新規
step を末尾に追加) と相性が悪い。明示 DELETE 順の方が SQL レベルで何が
起きるかが透明で、追跡しやすい。

### 下限を設けず operator 任せ

`retention: 1s` のような極端値で稼働中 session が消える事故を避けるため、
schema 段で 3600s 下限を強制した。下限を撤廃するなら稼働中 session の
invocation を retention 対象から除外するロジックが別途必要になり、設計
複雑度が上がる。

## Consequences

### 古い session は閲覧不能になる

cutoff より古い session の trace / span / log_records は UI から見えなく
なる。UI 側で「retention で消えた」表示は今回出さず、空状態のまま帰る。
必要になれば後続 ADR で UI 側の表示を追加する余地はある。

### 同一プロセス内では 1 時間に 1 回だけ

throttle のおかげで短時間に多数 `recordInvocationStart` / `runObservability`
が走っても実 DELETE は最初の 1 回のみ。プロセス起動コストへの影響は無視
できる範囲に収まる。

### 別プロセスは throttle を共有しない

cron 的に多数プロセスを連発すれば多数回 prune が走り得るが、現実の nas
運用 (1 プロセス = 1 session) では問題化しない。プロセス境界を超えた
協調は採らない。

### 初回 prune の長時間ブロック懸念

retention を後付けで有効化したケースで対象 invocation が大量にあると、
単一 tx で全削除を試みるため `busy_timeout = 5000ms` を超える可能性がある。
SQLite の `PRAGMA busy_timeout` 設定上は他 writer が retry するため致命
にはならないが、長時間ブロックは発生し得る。バッチ化 (cutoff を更に細かい
時間窓に切って複数 tx で消す) は将来の改善余地として残す。

### 既存 ADR との関係

ADR 2026042901 (observability + history) の partial supersede ではない。
あちらは「何を書くか」を決めた決定で、本決定は「いつ消すか」を独立に
追加した形になる。schema (DDL / `user_version`) は本 ADR で変更しないため、
ADR 2026051401 (migration 機構) との関係も独立。
