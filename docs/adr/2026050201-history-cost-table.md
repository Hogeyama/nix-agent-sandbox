---
Status: Draft
Date: 2026-05-02
---

# ADR (Draft): history page — model × token-type cost table

## Context

ADR 2026042901 で OTEL 経由の token usage 保存 (`spans.in_tok` /
`out_tok` / `cache_r` / `cache_w` + `spans.model`) は実装済み。一方 cost
換算は同 ADR の Open question として明示的に積み残されており、**単価
テーブルの取得経路 / 通貨 / Copilot の premium-request 単位との整合**
が未決定のまま生 token のみ保存している状態。

UI history page 側では現状 token 数を `historyListView.ts` で表示するだけ
で、

- 「今月どのモデルにいくら使ったか」が一目で分からない
- 単価が変わる将来を考えると「保存時点のスナップショット」を生 token と
  別に持っておきたい

という痛みがある。本 ADR では history page にコスト表示レイヤを足す
**設計**を決める (実装は別 commit)。

scope:

- 表示面: history list page に **縦軸=model / 横軸=token-type** の集計表
- データ面: 単価テーブルの取得経路 / キャッシュ / 古さの扱い
- 計算面: 4 種 token (input / output / cache_creation / cache_read) を
  モデル別単価で USD に換算する一次表現。Copilot は LiteLLM の per-token
  単価をそのまま乗算する (premium-request 課金は今月で終了するため対応
  しない)

scope 外:

- conversation detail / invocation detail page への展開 (list page で
  pattern を確立してから別 ADR で広げる)
- 通貨換算 (JPY 表示) / 累積予算アラート / per-budget cutoff
- 単価表のローカル編集 UI / per-conversation の単価固定 (rename / tag /
  単価 binding は ADR 2026042901 の `conversations` row の metadata 拡張
  として将来別ADR)
- spans への `cost_usd` カラム追加 (rejected — 後述)

## Decision

### 単価データソース: LiteLLM `model_prices_and_context_window.json`

`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
を真値とする。理由:

- **同種の OSS ツール (ccusage / claude-code-usage-analyzer 等) が事実上
  これを標準にしている**。Anthropic / OpenAI 双方を 1 ファイルに含み、
  date-stamped variant (`claude-sonnet-4-5-20250929` / `gpt-5-2025-08-07`)
  まで網羅
- **OTEL `model` attribute と直接突き合わせやすい key 形**: LiteLLM の
  key は `claude-sonnet-4-5-20250929-v1:0` / `gpt-5-2025-08-07` /
  provider prefix 付き variant (`anthropic/...`, `openai/...`) を併記。
  agent 側が emit する `model` 文字列は概ねこのどれかに引っかかる
- 必要 field がそのまま揃う:
  - `input_cost_per_token`
  - `output_cost_per_token`
  - `cache_creation_input_token_cost`
  - `cache_read_input_token_cost`

  値は **per-token USD** (e.g. `3e-06` = $3 / MTok)。`spans.in_tok` 等
  との掛け算で USD が直接出る。

採用しない:

- **Anthropic / OpenAI 公式 pricing page を直接 scrape**: HTML で
  format が安定せず、cache discount / batch / 地域別 azure 単価といった
  軸が散らばる。LiteLLM 経由なら 1 source に正規化済み
- **手書き JSON を repo に同梱して `bun run build-ui` 時に固める**:
  保守人力が必要。新モデル追加に commit が要る運用は痛い (現に Opus
  4.7 や Sonnet 4.6 が短いスパンで増えている)

### 取得タイミング & キャッシュ: UI daemon が抱える + 24h TTL

**fetch する主体は UI daemon。frontend は daemon に問い合わせるだけ**。

- frontend からの直 fetch は CORS こそ通るが (`raw.githubusercontent.com`
  は permissive)、page mount のたびに 1MB+ の JSON を transit させる
  と SSE 5 秒 poll のリズムと噛み合わず無駄
- daemon 側で 1 発取って共有 cache を見せる方が、history page が複数
  tab で開かれた時に redundant fetch を起こさない
- nas は既に **UI daemon を data ownership の境界**にしている (history
  reader / sidecars / audit 全部)。pricing も同じ層に置くのが筋

cache 仕様:

- 場所: `$XDG_CACHE_HOME/nas/pricing/litellm.json` (default
  `~/.cache/nas/pricing/litellm.json`)
- TTL: **24h**。理由:
  - LiteLLM 側の更新頻度は数日〜数週間スパン (commit log 観測)
  - history page を「開くたびに最新」要件は弱い (使い終わった会話の
    cost が遡及で動かない方が monthly 集計の安定性に寄与する)
  - 24h なら 1 日 1 回しか network が起きない
- 起動時 prefetch は **しない**: idle daemon が外部 GET を勝手に
  打つのは原則避ける。**最初に history page が開かれた時に lazy fetch**
  (cache miss / TTL expired のみ)
- cold-start (cache miss) は **fetch を await** する (10s timeout)。
  TTL 切れ cache は古い値を返しつつ background で refresh する
  (古い cache を出すデフォルト挙動を維持)
- bundled snapshot を repo に commit する fallback は **持たない** (上記
  rejected alternative 参照)。cold-start で network 失敗 → `unavailable`
  sentinel

  ```
  pricing endpoint hit
    ├─ cache hit (within TTL)        → return cache
    ├─ cache hit (TTL expired)       → return cache, kick async refresh
    ├─ cache miss + fetch OK         → write cache, return fresh snapshot
    └─ cache miss + fetch fail       → return "unavailable" sentinel,
                                       UI が "pricing unavailable" を出す
  ```

### Endpoint 形: 専用 REST 1 本 + SSE は触らない

`GET /api/pricing/snapshot` を新設し、frontend は history page mount 時
に **1 度だけ** 叩く。SSE には混ぜない。

```
GET /api/pricing/snapshot
→ {
    fetched_at: "2026-05-02T12:00:00Z",
    source: "litellm" | "unavailable",
    stale: false,
    models: {
      "claude-sonnet-4-5-20250929": {
        input_cost_per_token: 3e-06,
        output_cost_per_token: 1.5e-05,
        cache_creation_input_token_cost: 3.75e-06,
        cache_read_input_token_cost: 3e-07
      },
      "gpt-5-2025-08-07": { ... },
      ...
    }
  }
```

採用しない:

- **SSE history payload に cost を埋めて daemon 側で完成形を流す**:
  単価が動くと過去 SSE message が retroactive に書き換わる気持ち悪さ
  が出る (cache を出したあと background refresh で値が変わる時)。生
  token + 単価 snapshot を別経路で送り、**計算は frontend の純関数で
  やる**方が再現可能性が高い
- **per-model REST endpoint (`/api/pricing/:model`)**: モデル数 (50〜
  200) に対して page mount で N 回 round-trip を発生させる無駄。snapshot
  1 発で済む
- **SSE `pricing:snapshot` event**: pricing は 24h で 1 回しか変わらず、
  会話の live update と紐付かない。SSE に乗せる動機が無い

### Model 文字列の正規化: 多段 lookup + 不明モデルは別行で表示

OTEL `model` attribute は agent / 経路によって幅広い形で来る:

- Claude Code: `claude-sonnet-4-5-20250929` / `claude-opus-4-7` / 単に
  `claude-3-5-sonnet-latest` (resume 旧 session)
- Codex CLI: `gpt-5-2025-08-07` / `o3-2025-04-16` / `gpt-4o`
- Copilot CLI: 内部的には `gpt-5` / `claude-3-5-sonnet` 等 alias
- 空 / `unknown` も観測される (mapper が正規化前の vendor span を拾う等)

**lookup は frontend 側の純関数で多段に試す**:

1. 完全一致 (`models[model]`)
2. provider prefix を付けてみる: `anthropic/<model>`、`openai/<model>`、
   `azure/<model>`、`bedrock/<model>`、`vertex_ai/<model>`
3. version suffix を 1 段ずつ削る:
   `claude-sonnet-4-5-20250929-v1:0` → `claude-sonnet-4-5-20250929`
   → `claude-sonnet-4-5` → `claude-sonnet-4` (date suffix と `-vN:M`
   suffix を `\d{8}` / `-v\d+:\d+` regex で削る)
4. 既知の alias map (LiteLLM key と nas 内部の表記揺れ) を frontend
   純関数の const として持つ (例: `claude-3-5-sonnet-latest` →
   `claude-3-5-sonnet-20241022`)
5. それでも当たらなければ **未解決**として保持。table には別行 `(unknown:
   <model>)` で token 数のみ表示し USD 列は `—`。集計合計の USD には
   含めない (silent miscount を避ける)

正規化結果は per-row の表示に使うだけで、`spans` には書き戻さない。後で
LiteLLM が key を増やした時に過去 row も再解決される利点を取る。

### 集計と表示: list page 上部の固定 panel

history list page の **list の上** に固定 panel を出す。位置 (上 / 横 /
別 page) は draft 時点では list 上部固定とするが、最終的な layout 配置は
実装時に UI 検討で詰める (本 ADR では「集計を 1 つ画面に出す」までを決定
事項とする)。

```
┌─ Cost (last 30 days) ─────────────────────────────────────────────┐
│ Source: litellm (fetched 2h ago)               Total: $42.18      │
│                                                                    │
│  Model              | Input        | Output      | Cache W  | C R │
│  -------------------+--------------+-------------+----------+-----│
│  claude-sonnet-4-5  | 1.2M  $3.60  | 320k $4.80  | 800k $3.00 | …│
│  claude-opus-4-7    | 200k  $0.60  | 80k  $1.20  | …        |    │
│  gpt-5              | 1.5M  $4.50  | 250k $5.00  | —        | …  │
│  (unknown: foo)     | 50k   —      | 12k  —      | —        | —  │
│                                                                    │
│  ⚠ Copilot cost is an estimate (premium-request billing not       │
│     yet supported)                                                 │
└────────────────────────────────────────────────────────────────────┘
```

仕様:

- 行: `spans.model` の正規化後 key で `GROUP BY`。`(unknown: <raw>)` は
  raw 値ごとに独立行で残す
- 列: input / output / cache_write / cache_read の 4 つ。cell は
  「token 数 (k/M 表記) + USD」 (cache 系は単価モデル未対応なら USD 空欄)
- 期間: default は last 30 days。範囲 selector は **本 ADR の scope 外**
  (実装時に必要なら加えるが draft では固定)
- 通貨: USD 固定 (JPY 換算は scope 外)
- daemon → frontend は **生 token + pricing snapshot のみ**。集計と乗算は
  frontend 純関数で実施
- staleness badge: snapshot.stale=true (TTL 切れ background refresh 中)
  のときに「pricing data is N hours old」を panel ヘッダに表示。
  source="unavailable" のときは「Pricing unavailable」を出す

採用しない:

- **`spans` に `cost_usd` 列を追加して ingest 時に固定**: ADR
  2026042901 の rejected alternative と同根 (Copilot の premium-request
  と Anthropic per-token を同一列にできない)。**生 token + 単価
  snapshot 別保存**を維持する
- **conversation row metadata に固定単価を bind して再現性を確保**:
  rename / tag と同じく将来 metadata 拡張で扱う候補だが、まずは「現在
  単価で再計算」で十分使える。binding 機能は別 ADR
- **list page 全体の token 表示を cost と差し替え**: 既存 token 数表示
  は OTEL の生数値として保ち、cost は **追加 panel** として上に置く。
  cost に bug があった時に raw token と突き合わせて疑える経路を残す

### Source attribution / 透明性

panel ヘッダで以下を必ず見せる:

- `source: litellm | unavailable` (LiteLLM cache から計算したか、fetch
  失敗で計算できなかったか)
- `fetched_at` (相対表記: `2h ago` / `15m ago` / unavailable は `—`)
- `stale: true` 表示 (TTL 切れ + background refresh 中)

これがないと「なぜ今日の単価で計算されてないのか」がユーザに分からず
debug できない。

## Open questions

- **Codex の `cache_read` 扱い**: gpt-5 等の prompt caching が LiteLLM
  上で `cache_read_input_token_cost` を持つが、Codex CLI 側が
  `cache_read` を OTEL に乗せるかは ingest mapping 側で確認が必要 (ADR
  2026042901 の attribute alias list には `codex.turn.token_usage.
  cache_read_input_tokens` が入っている)。実装時に手元 DB で 0 でない
  値が観測できるか検証する
- **過去 row の遡及問題**: 24h TTL で背景更新するため、同じ history
  page を朝と夜で見ると合計が微妙に動く可能性がある。UX 上は許容と
  するが、「snapshot を pin する」UI が後で欲しくなる可能性 (ADR scope
  外)
- **不明モデル割合の運用 KPI**: 正規化が不十分だと `(unknown: ...)` 行が
  支配して総額が小さく出る。実装後しばらくは「unknown row の token
  比率」を panel 内に出して保守の対象にしたい (alias 追加 PR の trigger
  になる)
- **multi-region / batch 単価**: LiteLLM key には `_batches` /
  `_above_200k_tokens` / region 別 (`azure/eu/...`) variant があるが、
  nas が叩く agent はどれも standard region / non-batch しか経由しない
  ので **standard 単価のみ採用**で開始 (key suffix 含むものは無視)。
  必要が出てから扱う

## Rejected alternatives

- **frontend が直接 LiteLLM JSON を `raw.githubusercontent.com` から
  fetch**: page mount のたびに 1MB+ payload を引く。daemon 側 cache が
  あれば 1 user / 1 day / 1 fetch で済むのを毎 mount に膨らませるのは
  もったいない。CORS 自体は通るが network policy の観点でも daemon に
  集約した方が良い
- **取得 source を Anthropic / OpenAI 公式 pricing page (HTML scrape)**:
  HTML が安定しない。cache discount / batch / 地域変動を別軸で並べる
  必要が出る。LiteLLM が既に正規化してくれているなら踏襲した方が
  cheap
- **手書き JSON を `src/history/pricing/static.json` として固定**:
  保守人力。新モデル / 単価改定で commit が要る運用は痛い (Opus 4.7 /
  Sonnet 4.6 のように短期間で何度も増える)。live fetch + cache に倒す
- **TTL を 1h / 起動時 prefetch / SSE で push**: 単価は 1 日に 1 度も
  動かないのが普通。短い TTL は SQLite と違って外部依存を増やす方向
  (rate limit / network 落ち)。24h で十分
- **`spans` に `cost_usd` を ingest 時に固定書き込み**: ADR 2026042901
  rejected と同根。Copilot premium-request と Anthropic per-token の
  共存ができない。「生 token + 単価 snapshot を別経路で保存し計算は
  view 側」を維持
- **不明モデル row を「Other」1 行にまとめる**: 集計総額に紛れて silent
  miscount のリスクが上がる。raw 値ごとに別行で残し、実装側が「この
  alias を加えれば解消する」を見つけられる方を優先する
- **history page を開かなくても daemon 起動時に prefetch**: 起動直後の
  user が pricing data を必要としていないことが多い。idle daemon が
  外部 GET を勝手に打つのは最小権限的にも避けたい。lazy fetch にする
- **per-conversation / per-invocation の cost 表示は同 ADR で全部やる**:
  list page で pattern を確定させてから別 ADR で広げる (table layout /
  小数点 / Copilot 注記 などの体裁が崩れる前に統一)
