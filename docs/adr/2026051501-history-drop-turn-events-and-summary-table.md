---
Status: Accepted
Date: 2026-05-15
---

# ADR: history.db から turn_events / conversation_summaries を撤去し summary を read-time derive に倒す

## Context

ADR 2026042901 は `turn_events` テーブルを nas hook 由来の turn 単位
イベントを保存する場所として導入した。これに加えて、conversation 一覧の
1 行プレビュー (summary) を hook payload から組み立てて保存する
`conversation_summaries` テーブルが運用上追加された (hook が初出 prompt
本文を 240 文字に切り詰めて INSERT する設計)。

その後、観測性経路は次の 2 つの進化を経た:

- ADR 2026042901 自体で OTLP `/v1/traces` 受理が立ち上がり、span 構造から
  trace 単位の prompt 抽出 (`extractTracePrompts`) が利用可能になった
- ADR 2026051301 で `/v1/logs` 受理を足し、`user_prompt` event と
  `api_request` event を `log_records` に保存するようになった。これにより
  Claude / Copilot の双方で「最初の user prompt 本文」を OTEL 由来で安定して
  得られるようになった

結果として、conversation summary を出すのに必要な情報は OTEL 由来で
出揃っており、hook 由来の `conversation_summaries` は OTEL 由来データの
**二重持ち** になっている。`turn_events` についても grep で確認した範囲で
UI / SSE / Reader のいずれも読んでおらず、書き手 (hook) しかいない
**dead read path** となっていた。

二重持ちは具体的に次の歪みを生んでいた:

- hook 由来 summary は 240 文字 truncate、OTEL 由来 first-trace prompt は
  full body。ユーザは同じ会話を list と detail で見比べた際に「冒頭が違う」
  ように見える
- hook は history.db を開いて prepare / run を 2 度走らせており、hook 実行
  時間に DB I/O が乗っていた。hook の "never fails" 契約 (sub-process
  失敗で session を落とさない) のために、writer 側 migration の
  `HistoryDbVersionMismatchError` を hook 経路でも catch する保険コードが
  必要になっていた

## Decision

### `turn_events` / `conversation_summaries` テーブルを撤去 (schema v4)

`HISTORY_DB_USER_VERSION` を 3 → 4 に bump し、新規 migration step
`MIGRATION_V4` で `DROP TABLE turn_events` / `DROP TABLE conversation_summaries`
を発行する。新規 DB の初期 schema からも両テーブル定義を除く。

撤去の前提は ADR 2026051401 の auto-migration 機構で、v3 stamp の DB を
持つ operator も次回 writer 起動で v4 まで自動適用される (手動 `rm` を
強いない)。

### `ConversationListRow.summary` は read-time derive

list page が出す `summary` 列は reader 内で算出する。具体的には、当該
conversation に紐付く trace の中で `started_at ASC, trace_id ASC` の
順に最初の 1 件を取り、その trace の最初の user prompt 本文をそのまま
返す。データソースは OTEL `/v1/logs` の `user_prompt` event を
`log_records` に保存したもの、または `/v1/traces` の `claude_code.user_prompt`
span event を `spans.attrs_json` に保存したもの (どちらも
`extractTracePrompts` が吸収する)。

trace が 1 件も無い conversation (= observability disabled / 何も飛ばない
session) では summary は `null` を返し、UI は `idShort` fallback で表示する。

### Summary は truncate しない

reader は full body を返す。一覧での 1 行化は表示層 (CSS `line-clamp`) に
寄せる。旧 `SUMMARY_MAX_CHARS` (240) の暗黙契約は撤去する。

### hook は history.db に触らない

`nas hook` は session store の更新と user 通知発火のみ担当し、history.db
を開かない。これにより hook 経路の `HistoryDbVersionMismatchError` catch
は不要になり、撤去する。hook の "never fails" 契約は経路ごと削除する形で
強化される。

## Alternatives considered

### `turn_events` を「使ってないが残す」

dead schema を保留して将来の turn 単位ビューに備える案。schema は
migration debt として時間と共に累積し、新しい migration step を足す
たびに「使われていないテーブルもメンテ対象に入る」コストを払うことに
なる。実需が生じた時点で新規 ADR で再導入する方が筋。却下。

### `conversation_summaries` を materialize し続ける (二重持ち容認)

hook 由来 summary を維持しつつ OTEL 由来 prompt も併存させる案。
list 画面の summary と detail 画面の prompt 本文が異なる文字列に見える
UI バグ温床を抱え続けることになる。truncate / 非 truncate のどちらに
寄せても整合性は取れない (240 字に揃えるなら情報損失、full に揃えるなら
hook 書き込み時点で truncate しない別仕様)。却下。

### drop ではなく rename して quarantine

`turn_events` / `conversation_summaries` を `_legacy_*` に rename して
読み取りだけ残す案。書き手が居ない以上 quarantine table は冷蔵保管
されるだけで実質 drop と等価、しかし schema 上は残り migration debt
だけが積み上がる。drop と同じ運用コストで読み取り経路だけ複雑になる
ため却下。

## Consequences

### v3 stamp DB を持つ operator への影響

writer 初回 open 時に v4 まで auto-migrate され、`turn_events` および
`conversation_summaries` のレコードは喪失する。両テーブルは UI から
読み取られていない上、`conversation_summaries` は OTEL 由来データから
read-time に再生成できるため、ユーザ体験上の退行は生じない (受容)。

### hook 実行時間の短縮

hook code path から history.db 依存が消える。DB open + prepare/run ×2
ぶんの I/O が消え、hook の wall time が縮む。`HistoryDbVersionMismatchError`
catch も hook 側からは消える (writer 経路にのみ残る)。

### observability disabled session で summary が常時空

OTEL 経路を一切張らない session では `log_records` も `spans` も生まれず、
list の summary 列は常に `null` (= UI 上は `idShort` 表示) になる。元の
hook ベース仕様でも hook が動かない経路では summary が空だったので、
退行ではなく挙動の単純化に当たる。

### 表示制御は CSS clamp に一本化

reader が full body を返す前提のため、行数制限・幅制限は CSS
`line-clamp` (または同等の overflow 制御) に集約される。
`SUMMARY_MAX_CHARS` の暗黙契約は廃止され、長い prompt の表示挙動は
UI 側だけで完結する。

### 旧 ADR との関係 (partial supersession)

- ADR 2026042901 の「データモデル: Invocation / Conversation / Trace の
  三層」節のうち `turn_events` テーブル定義および付随する 2 つの index
  (`idx_turn_events_invocation` / `idx_turn_events_conversation`) は
  本 ADR で撤去される。schema の残り (invocations / conversations /
  traces / spans) は引き続き有効
- 同 ADR の「turn_events への conversation_id 付与: hook payload から
  直接取る」節は本 ADR で完全に廃止される。hook は history.db に書かない
- 同 ADR の rejected alternative「`turn_events.conversation_id` を後から
  OTLP 受信で backfill」も本 ADR の決定により議論ごと過去のものになる
  (turn_events 自体が無くなるため)
- ADR 2026042901 frontmatter Status は据え置き (Accepted)。影響セクション
  に inline note を入れる形で partial-supersession を記録する
- ADR 2026051301 (`log_records` の `user_prompt` / `api_request` event) を
  summary derive の安定ソースとして流用する。本 ADR で `log_records`
  schema 側の変更は無い
- ADR 2026051401 の auto-migration 機構が v3 → v4 drop の運用前提
