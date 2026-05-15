---
Status: Accepted
Date: 2026-05-16
---

# ADR: observability — OTEL ingest module structure (otlp_wire 抽出 + transform/write 分離)

## Context

ADR 2026042901 で `/v1/traces` receiver と SQLite ingester (`src/history/ingest.ts`)
を導入し、ADR 2026051301 で `/v1/logs` ingester (`src/history/ingest_logs.ts`) を
追加した結果、2 つの signal ingester が並存している。

この状態で `ingest.ts` (440 行) は二つの役割を抱えている:

- traces ingester 本体 (OTLP `ResourceSpans` payload を walk して `spans` /
  `traces` / `conversations` テーブルに書く)
- 両 signal 共通の wire-level helper の置き場 (`OtlpKeyValue` /
  `OtlpAttributeValue` / `flattenAttributes` / `unwrapAttrValue` /
  `readStringAttr` / `nanoToIso` / `stripPiiAttrs` / `PII_ATTR_KEYS`)

`ingest_logs.ts` は後者の helper 群を `ingest.ts` から side-import している。
「logs ingester が traces ingester の内部 module に依存する」逆参照が
発生しており、2 signal が peer の関係になっていない。

加えて `ingestResourceSpans` 関数自体が

1. OTLP payload を walk して SpanRow / 関連 metadata を構築する pure な
   データ変換段
2. sqlite transaction 内で `upsertConversation` / `upsertTrace` / `insertSpans`
   を呼ぶ書き込み段

を 1 関数で抱えており、変換境界と書き込み境界が混ざっている。

機能変更を伴わない structural な歪みなので、refactor 1 commit で整える。

## Decision

### 共有 wire primitive を `src/history/otlp_wire.ts` に独立させる

両 signal が共有する wire-level の primitive を `src/history/otlp_wire.ts`
に切り出す:

- 型: `OtlpKeyValue`, `OtlpAttributeValue`
- 関数: `flattenAttributes`, `unwrapAttrValue`, `readStringAttr`,
  `nanoToIso`, `stripPiiAttrs`
- 定数: `PII_ATTR_KEYS`

traces-specific な wire 型 (`OtlpJsonExportPayload`, `OtlpJsonResourceSpans`,
`OtlpJsonScopeSpans`, `OtlpJsonSpan`, `OtlpJsonSpanEvent`) は `ingest.ts` に残す。
logs-specific な wire 型は `ingest_logs.ts` 内のローカル定義のままで対称に
保つ。「shared primitive と signal-specific 型は別物として扱う」という
分割線を引く。

re-export shim (`ingest.ts` から `otlp_wire` を re-export する層) は **作らない**。
歪みを移すだけになるため、移動先で peer import に統一する。

### `ingestResourceSpans` を transform / write の二段に分ける

`ingestResourceSpans` の本体を内部で 2 つの helper に分ける:

- `transformResourceSpans(payload, fallback)`: pure。OTLP payload を walk
  して、書き込みに必要な plan (SpanRow 配列 + 各 trace ごとの
  conversation 解決結果) と `droppedTraces` カウンタを返す。db に触らない
- `applyIngestPlans(plans, db)`: db write。`db.transaction` 内で
  `upsertConversation` / `upsertTrace` / `insertSpans` を呼び、
  `acceptedSpans` / `resolvedConversations` カウンタを集計して返す

`ingestResourceSpans` 自身はこの 2 つを呼んで `IngestResult` を合成する
薄い orchestrator になる。**公開 API (`ingestResourceSpans` の signature と
`IngestResult` の shape) は不変**。

両 helper は module-internal に留め、現時点で export しない (test 要件が
出てから別 commit で export 切替する)。

カウンタ計上位置:

- `droppedTraces`: **transform 段で計上**。`nas.session.id` が欠落している
  trace を drop する判定は payload を見るだけで決まるため、db write を
  待つ理由が無い
- `acceptedSpans`: **write 段で計上**。`insertSpans` の戻り値 (実際に
  書いた行数) を集計する
- `resolvedConversations`: **write 段、`db.transaction` 内で
  `upsertConversation` 呼び出しと lockstep**。transaction が rollback された
  場合に counter が「実際に書いた数」を反映する不変を保つ

multi-resource を 1 transaction で書く既存セマンティクス (1 batch =
1 transaction、resource を跨いだ all-or-nothing) は不変。

## Alternatives considered

- **traces 固有 wire 型まで `otlp_wire` に含める**: logs 側の対応物 (logs
  specific 型) は `ingest_logs.ts` 内ローカルなので、traces だけ shared
  module に含めると非対称になる。shared primitive と signal-specific 型は
  別物として扱うほうが分割線が一貫する
- **`src/otlp/` 層を新設して history 配下から外に出す**: history 以外の
  consumer が現状無いため、抽象階層を増やす正当性が薄い (premature)。
  signal 数または consumer 数が増えた時点で再考すれば足る
- **`transformResourceSpans` を即 export し unit test を本 commit で生やす**:
  scope を絞り「機能変更ゼロ」を担保する判断。test を加える commit は
  別途切る (test 要件が立ってから export を切り替える)
- **`nanoToNumber` も `otlp_wire` に移す**: logs 側で未使用。共有資源にする
  根拠が無く、移すと false generalisation になる
- **transform 段で `resolvedConversations` を pre-count する**: transaction
  rollback 時に「書いていないが counter は増えた」不整合が生じる。counter
  は実書き込みと同じ transaction 内で進める方針を取る
- **`ingest.ts` から `otlp_wire` を re-export する shim を残す**: import 経路
  の歪みが残るだけ。logs 側の side-import を解消するという動機と直接矛盾
  するため採らない

## Consequences

- `ingest_logs.ts` の `ingest.ts` 経由 side-import が解消され、両 ingester
  は `otlp_wire` を peer として depend する形になる。signal 間の依存方向が
  対称に揃う
- `src/history/otlp_wire.ts` は両 signal の共有 wire primitive の唯一の
  置き場。`ingest_logs.ts` / `ingest.ts` のどちらが先に変更されても peer
  依存先が一意で、変更影響範囲を読みやすい
- `ingestResourceSpans` の内部が transform 境界 / write 境界で読めるよう
  になり、将来 pure transform に対する unit test を生やせる素地ができた
  (本 ADR の scope 外)
- `ingest.ts` の行数は 440 → 約 300 行に縮む (wire 抽出で約 130 行減 +
  関数分割で構造化)
- `transformResourceSpans` / `applyIngestPlans` は module-internal のまま。
  export 切替は test 要件が立ってから別 commit で行う
- 公開 API は不変なので caller (`receiver.ts` の `/v1/traces` ハンドラ) は
  改修不要
