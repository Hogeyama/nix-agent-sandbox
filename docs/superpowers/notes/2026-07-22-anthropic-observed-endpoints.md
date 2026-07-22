# api.anthropic.com 観測エンドポイント一覧（egress スコープ follow-up 用）

## 目的

`MaskConfig.anthropicEgress` の fail-closed スコープ（確定判断 #4:「スキーマ対象は
`/v1/messages`・`/v1/messages/count_tokens` のみ、他は 403」）を実トラフィックに照らして
再検討するための観測データを記録する。**設計判断は保留**。ここは事実の記録のみ。

## データ源

- 2026-07-22 のライブセッションの mitmproxy ログ（`docker logs nas-proxy-shared`）。
- 非 egress セッションの通常ログ（200 応答の確認）と、`anthropicEgress=true` セッションの
  `[nas-addon] SCHEMA-BLOCKED` ログ（`grep SCHEMA-BLOCK | sort | uniq`）の2系統。
- この環境からは Docker 不可のため再取得しておらず、ユーザー提供のログをそのまま転記した。
  網羅的ではなく「このセッションで観測された分」に限る。

## 現状の addon 挙動（このブランチ HEAD 時点）

- `_anthropic_json_endpoint(method, path)` は **POST の `/v1/messages`・`/v1/messages/count_tokens`
  のみ**を既知とし、それ以外（GET 全部・他パスの POST）は `None` → `_plan_anthropic_masking`
  が `block` → **403 fail-closed**。
- したがって下表の「schema」以外は anthropicEgress 有効時に 403 になる。

## 観測エンドポイント

### 必須（load-bearing）— schema-mask 対象

| method | path | anthropicEgress 時 | 役割（推測） |
| --- | --- | --- | --- |
| POST | `/v1/messages?beta=true` | schema-mask → 200 | モデル推論。チャットの唯一の硬い依存。観測で 200。 |
| POST | `/v1/messages/count_tokens` | schema-mask（設計上） | トークン数見積り。今回のログには未出現。 |

### 補助・ベストエフォート — 現状 403（fail-closed）になる

観測された `SCHEMA-BLOCKED` 対象。役割欄は名前と挙動からの**推測**（Claude Code 内部仕様の
確証ではない）。いずれも 403 でもチャットは継続した＝ Claude Code が必須にしていない。

| method | path | ボディ | 役割（推測） |
| --- | --- | --- | --- |
| GET | `/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8` | なし | 起動時ブートストラップ設定取得 |
| GET | `/api/claude_code_penguin_mode` | なし | フィーチャーフラグ的な何か |
| GET | `/api/claude_code/policy_limits` | なし | ポリシー/レート制限の取得 |
| GET | `/api/claude_code/settings` | なし | リモート設定同期 |
| GET | `/mcp-registry/v0/servers?version=latest&limit=100&visibility=commercial%2Cgsuite%2Centerprise%2Chealth` | なし | MCP サーバレジストリ一覧 |
| GET | `/v1/code/triggers` | なし | triggers 機能 |
| GET | `/v1/mcp_servers?limit=1000` | なし | MCP サーバ一覧 |
| POST | `/api/claude_code/metrics` | あり | メトリクス送信（fire-and-forget、リトライあり） |
| POST | `/api/event_logging/v2/batch` | あり | イベントログ送信（fire-and-forget、リトライあり） |
| POST | `/api/eval/sdk-zAZezfDKGoZuXXKe` | あり | eval 系送信（末尾はセッション固有 ID と思われる） |

### 参考: allowlist で deny されるもの（anthropicEgress とは無関係）

| method | path | 挙動 |
| --- | --- | --- |
| POST | `http-intake.logs.us5.datadoghq.com/api/v2/logs` | reviewRules の `deny` により 403。api.anthropic.com ではない。 |

## 観測からの所見（判断は保留）

- **GET はボディが無い**ため、脅威モデル（エージェントが読んだ秘密がリクエストボディに載る）が
  そもそも当てはまらない。GET を 403 にする根拠は薄い。
- 非 messages の **POST（metrics/event_logging/eval）** はボディを持つが、宛先は同じ Anthropic
  信頼境界。平文秘密なら既存のバイト単位マスクでも捕捉でき得る。403 で壊す必要性は要検討。
- `/v1/files` は**今回のログに出現していない**（ファイルアップロード未発生）。files を実際に
  ブロックして動作確認したわけではない。files のボディは base64 のファイル本体を運ぶため、
  バイト単位マスクでの取りこぼし懸念があり、扱いは実データを見て別途判断する。
- 「チャットが動く」＝「無害」ではない。MCP サーバ未ロード・設定/ポリシー未同期・テレメトリ
  失敗のリトライストームは実際に発生している（機能低下として表面化しにくいだけ）。

## 未決事項（次回判断する）

- anthropicEgress 有効時、非 `/v1/messages` 経路の既定を「403」から「バイト単位マスク+passthrough」
  （＝他の全 allow ホストと同じ挙動）へ変更するか。
- `/v1/files` を fail-closed のまま残すか、スキーマ対応するか。
- テレメトリ系（metrics/event_logging/eval）を明示 allow / passthrough にするか。
- これらを可視化する「Anthropic egress リクエスト一覧」CLI 機能の要否・スコープ。
