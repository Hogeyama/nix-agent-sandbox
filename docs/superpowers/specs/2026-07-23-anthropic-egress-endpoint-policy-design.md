# Anthropic egress エンドポイントポリシー設計

## 背景

`mask.anthropicEgress=true` は現在、`POST /v1/messages` と
`POST /v1/messages/count_tokens` だけをスキーマ認識マスクの対象とし、
それ以外の `api.anthropic.com` リクエストをすべて 403 にする。

2026-07-22 のライブセッションでは、Claude Code が Messages API 以外にも
設定、ポリシー、MCP レジストリ、テレメトリ等のエンドポイントを利用することが
観測された。これらがすべて 403 でもチャット自体は継続したが、設定や MCP の
未取得、テレメトリのリトライなどの機能低下が起きる。

一方、未知エンドポイントを汎用バイトマスクで通すと、アプリケーション層で
エンコードされた既知シークレットを取りこぼし得る。既知シークレットを Anthropic
へ送らないという保証を、互換性改善のために弱めてはならない。

## 目標

- 観測済みの補助 GET を、リクエストボディを持たない場合に限って利用可能にする。
- Messages API のスキーマ認識マスクを維持する。
- テレメトリ、Files API、未知経路は引き続き fail-closed にする。
- block の理由を秘密を含まない形で監査できるようにする。
- Claude Code のリトライによるログノイズを集約する。

## 非目標

- テレメトリに成功応答を偽装すること。metrics、event logging、eval は 403 にする。
- Files API を利用可能にすること。
- 未知の Anthropic API を自動的に許可すること。
- レスポンスボディのマスク。漏洩制御の対象は egress リクエストである。
- 意図的な非標準多重エンコードによる回避。脅威モデルは既存設計と同じく、
  Claude Code が既知シークレットを通常のフィールドへ誤って載せるケースである。

## エンドポイント分類

addon に純粋な routing 分類器を置く。入力は HTTP method と query を除いた path、
出力は endpoint class と安全な route label である。各 class の handler が body の
取得状態と構造を検査し、最終 action と reason を返す。

### `schema-mask`

次の2経路だけを対象とする。

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

既存の `_schema_mask_json` を適用する。未知ブロック型、JSON の解析・再直列化失敗、
body 取得不能は block にする。

### `bodyless-pass`

次の GET 経路だけを対象とする。

- `/api/claude_cli/bootstrap`
- `/api/claude_code_penguin_mode`
- `/api/claude_code/policy_limits`
- `/api/claude_code/settings`
- `/mcp-registry/v0/servers`
- `/v1/code/triggers`
- `/v1/mcp_servers`

次の条件をすべて満たした場合だけ上流へ転送する。

1. method が `GET` である。
2. query を除いた path が表の値と完全一致する。
3. body を正常に取得できる。
4. body の長さがゼロである。
5. URL と全リクエストヘッダーへ既存のパターンマスクを適用できる。

query はルーティングには使わないが、転送前にマスクする。prefix 一致、percent-decode
後の一致、二重 slash の正規化は行わない。末尾 slash も別 path として block する。

認証ヘッダーの注入はこれまでどおりマスク後に行い、注入した credential 自体を
マスクまたは監査ログへ記録しない。

### `block`

上記2分類以外はすべて 403 にする。明示的な対象には次を含む。

- `POST /api/claude_code/metrics`
- `POST /api/event_logging/v2/batch`
- `POST /api/eval/*`
- `POST /v1/files`
- body 付きの許可 GET
- body を取得できないリクエスト
- 未知の method または path

テレメトリは local-success にせず、Anthropic へ送らないことをクライアントへ正直に
示す。リトライが残ることは、保証を優先した意図的なトレードオフである。

## Files API の扱い

`POST /v1/files` は `multipart/form-data` でファイル本体を Anthropic のストレージへ
アップロードし、後続の Messages API で参照する `file_id` を得る経路である。
JSON 内の base64 blob を送る経路ではない。

multipart、圧縮ファイル、アーカイブ、各種バイナリを完全に検査する設計が無いまま
許可すると、ワークスペースのファイルを丸ごと漏洩させ得る。単純置換はバイナリを
壊す一方、圧縮された秘密を検出できない。したがって本設計では block を維持する。

Files API が必要になった場合は、許可 MIME type、multipart parser、圧縮形式、
サイズ上限、検出時にファイル全体を拒否するかを別 spec で決める。

## addon の処理順

`api.anthropic.com` かつ `anthropicEgress=true` のリクエストは次の順に処理する。

1. 従来どおり broker へ authorization を問い合わせ、mask patterns を取得する。
2. URL と全リクエストヘッダーをマスクする。
3. query を除いた path を endpoint table と完全一致で分類する。
4. `schema-mask` は body を検査・必要なら書き換える。
5. `bodyless-pass` は body が取得可能かつ空であることを検査する。
6. `block` は上流接続前に固定の 403 を返す。
7. 最終 action を broker へ egress outcome として報告する。
8. allow の場合だけ credential header を注入して上流へ転送する。

現状は schema 判定で block した後に URL・ヘッダーのマスク処理へ到達しないため、
`SCHEMA-BLOCKED` が未マスク query を出力し得る。マスクを分類・ログより前へ移すことで
この順序を修正する。

## エラーと安全なログ

クライアントへ返す 403 body は固定文言とし、method、path、query、header、body、
filename を含めない。

内部 reason は次に限定する。

- `recognized-schema`
- `known-bodyless-endpoint`
- `unknown-endpoint`
- `unexpected-body`
- `body-unavailable`
- `schema-unknown`
- `decode-failed`
- `file-upload-blocked`

ログに出せる request 情報は method と安全な route label だけである。route label は
許可表の定数、`/v1/files`、`/api/eval/:id` 等の固定テンプレート、または `unknown` と
する。受信した生 path からログ文字列を組み立てない。

同一 `(session, method, route, action, reason)` の stderr block は最初の1件を出し、
以後は件数が2の累乗になった時だけ累計件数を出す。これにより時計やバックグラウンド
flush に依存せず、リトライストームを抑えながら継続を確認できる。

## 監査

新しい CLI サブコマンドは作らず、既存の `nas audit --domain network` を拡張する。

authorization の allow/deny と、addon が決める最終 egress action は異なる層の判断で
ある。broker が allow した後に addon が schema 理由で block する場合があるため、
既存の authorization audit を上書きしない。

### outcome protocol

addon からセッション broker へ、既存 UDS を使って `egress_outcome` を送る。
メッセージは次だけを含む。

- 元の `requestId` と `sessionId`
- method
- 安全な route label
- action: `schema-mask | bodyless-pass | block`
- reason

成功時の reason は `recognized-schema` または `known-bodyless-endpoint` とする。
秘密を実際に検出したかどうかは監査へ記録しない。

broker は接続先セッションと `sessionId` の一致、action/reason/route の列挙値を検証して
から audit store へ書く。raw path、query、header、body はプロトコルに載せない。
outcome の記録失敗は安全なローカルエラーとして扱い、allow/block の判断自体は変えない。

### audit schema と表示

`AuditLogEntry` に後方互換な optional field を追加する。

- `phase?: "authorization" | "egress"`
- `method?: string`
- `route?: string`
- `egressAction?: "schema-mask" | "bodyless-pass" | "block"`

既存行の `phase` は読み出し時に `authorization` と解釈する。SQLite migration は nullable
column の追加だけにする。JSON mode は各 outcome をそのまま返す。

通常の text mode では、連続する同一 session/method/route/action/reason の egress 行を
1行へまとめて `xN` を表示する。authorization 行の既存表示は変更しない。

## コンポーネント境界

- endpoint table、path 分類、action/reason 決定、route label 化は
  `src/docker/mitmproxy/nas_addon.py` の純粋関数にする。
- mitmproxy flow の読み書き、broker UDS 呼び出し、403 応答は addon の request handler
  が担当する。
- broker は outcome の検証と audit 書き込みだけを担当し、Anthropic endpoint policy を
  重複実装しない。
- audit query は既存 `AuditQueryService` を維持し、CLI/UI が primitive store を直接
  呼ばない。
- proxy stage は config と broker lifecycle のオーケストレーションに留め、primitive I/O
  を追加しない。

この分離は `effect-separation` の stage/service 境界と、`security-constraints` の
コンテナへ control surface やシークレットを露出しない制約を維持する。

## テスト

### Unit

`src/docker/mitmproxy/nas_addon_mask_test.py` で分類器の全マトリクスを検証する。

- 許可 GET 7経路 × 空 body は `bodyless-pass`
- 同じ経路の非空 body、body 取得不能は block
- query 付き既知 path は許可
- prefix 偽装、percent-encoded path、二重 slash、末尾 slash、未知 method は block
- Messages 2経路だけ `schema-mask`
- telemetry、eval、Files、未知 path は block
- block log に query、secret、body が含まれない
- URL と重複 header が分類前にマスクされる
- stderr 集約が1、2、4、8件目だけを出す

TypeScript unit test では `egress_outcome` の列挙値検証、session 不一致拒否、audit text
集約、既存 authorization 表示の非回帰を検証する。

### Integration

既存の `src/docker/mitmproxy/nas_addon_integration_test.ts` を拡張する。

- 代表の既知 GET が upstream へ届く
- query/header の既知 secret がマスクされる
- body 付き GET、telemetry POST、Files POST は 403 かつ upstream 未到達
- 未知 path の block log に生 path/query が残らない

broker integration test では outcome が egress phase の audit entry として保存されることを
検証する。Docker テストはランダムなリソース名、`skipIf` guard、`finally` cleanup、実際の
`api.anthropic.com` へ到達させない backstop を維持する。

テストは Bun の現行構成に従い、Python unit、対象 Bun unit、対象 integration、最後に
リポジトリ標準の format・lint・type check・test を実行する。

## ドキュメント更新

`docs/superpowers/notes/2026-07-22-anthropic-observed-endpoints.md` の Files API 説明を、
「base64 のファイル本体」から「multipart/form-data のファイル本体」へ訂正する。
観測ログには `/v1/files` が出ていないこと、block 維持の判断は変えない。

## 残余リスクと意図的なトレードオフ

- telemetry を 403 にするため Claude Code のリトライは残る。ログ集約で運用ノイズだけを
  抑える。
- Anthropic が補助 GET の path や method を変更した場合、新経路は更新まで block される。
- GET の query/header は既存の raw、percent-encoded、base64 pattern mask の範囲で保護
  する。意図的な独自エンコード回避は既存の脅威モデル外である。
- outcome audit は authorization audit と別行になる。`phase` と同一 `requestId` により、
  broker の許可後に addon が拒否したことを曖昧にしない。
