---
Status: Accepted
Date: 2026-05-16
---

# ADR: observability — OTLP semantics モジュールの所属 (src/agents/ → src/history/)

## Context

ADR 2026042901 で span classification の 7-layer rule を定め、その実装は
`src/agents/otlp.ts` (321 行) に集積している。同モジュールは

- span classification: `classifySpan`, `SpanKind`
- usage column resolution: `resolveSpanUsageColumns`, `analyzeTraceUsageSources`
- conversation-id resolution: `pickConversationIdFromSpans`

を抱えており、内容は一貫して「OTLP semconv に対する意味解釈」=
OTLP semantic knowledge である。

一方で実際の consumer は `src/history/ingest.ts` の 1 箇所のみで、
`src/agents/` 配下にはこのモジュールを参照するコードは存在しない。

`src/agents/` の責務は本来「agent 起動時の env / argv / container wiring」
であり、OTLP semantic knowledge とは性質が異なる。結果として
「`agents/` 配下に置かれているが、`history/` だけが consume する」という
モジュール名と依存方向の不一致が発生している。機能変更を伴わない
structural な歪みなので、location を整える 1 commit を切る。

## Decision

`src/agents/otlp.ts` を `src/history/otlp_semantics.ts` に移動する。
対応する test ファイル `src/agents/otlp_test.ts` も
`src/history/otlp_semantics_test.ts` に同時 rename する。

- 移動は **コンテンツ 0 byte 変更**で行う (`git mv` で履歴を保持)
- コンテンツ側の変更は次の 2 行のみ:
  - `src/history/ingest.ts` の import path 1 行
    (`../agents/otlp.ts` → `./otlp_semantics.ts`)
  - rename した test ファイルの self import 1 行
- モジュール内に残る "Agent" の言及 (doc comment 中の `invoke_agent`
  など) は OTLP semconv における operation 名を指しており、ファイル所属を
  `agents/` から離しても意味は変わらないため untouched

## Alternatives considered

- **新層 `src/otlp/` を作って history 配下から外に出す**: 現時点で
  consumer は `src/history/` の 1 箇所のみ。signal 数や consumer 数が
  増え、複数階層から触る状況になった時点で再考すれば足る。今 1 consumer
  の段階で抽象階層を増やす正当性が薄い (premature)
- **layering 反転を意図的に受け入れ、docstring で明文化して move しない**:
  `agents/` の責務定義 (env / argv / container wiring) と、実際の内容
  (OTLP semantic knowledge) を整合させる根拠が docstring 1 枚しかない。
  コード位置 (ディレクトリ所属) で示せるのであれば、そちらの方が読み手に
  対する手がかりとして強い
- **`otlp_semantics` と `otlp_wire` を 1 モジュールに統合する**:
  「pure wire format helper」と「OTLP semconv の意味解釈」は依存方向が
  異なる (semantics は wire helpers を必要としないが、wire は semantics
  を知らない)。混ぜると `src/history/` 内に余計な階層感が残るだけになり、
  各モジュールの責務が読みにくくなる

## Consequences

- `src/agents/` 配下から OTLP 関連コードが完全消失し、`agents/` =
  "agent wiring" の責務定義がコード位置と一致する形で再確立される
- `src/history/` 内では wire primitive (`otlp_wire.ts`) と semantic
  knowledge (`otlp_semantics.ts`) が 2 ファイルに分かれ、ingester 本体
  (`ingest.ts`) はその上に乗る構造になる。各モジュールの責務境界が
  ファイル分割と対応する
- `otlp_semantics.ts` 内に file-local な `readStringAttr` が残っており、
  これは `otlp_wire` の同名 export と signature が同一である。本 move
  では差分を import path のみに絞る判断を優先し、intentional に統合せず
  残す。今後 cleanup の余地として明示しておく
- ADR 2026042901 で記録された span classification 7-layer rule は本 ADR
  では touch しない。本 ADR が扱うのは **モジュール所属の決定**であり、
  classification rule 本体の意思決定は当該 ADR にある。両者は別軸の決定で
  あり partial supersede ではない (frontmatter Status も変更しない)
