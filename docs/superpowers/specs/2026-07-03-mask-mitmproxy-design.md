# mitmproxy リクエストマスク設計

日付: 2026-07-03
ステータス: 承認済み(実装計画待ち)

## 目的

MaskConfig(`mask.values`)の適用対象を mitmproxy プロキシに拡張する。
エージェント発の HTTP/HTTPS リクエストに秘密値が含まれる場合、プロキシが送出前に `****` へ置換し、秘密値が外部に出る経路を塞ぐ。
maskfs がワークスペースのファイル読み取り経路を塞ぐのに対し、本機能はネットワーク送出経路を塞ぐ多層防御である。

## 要件(確認済み)

- **対象はリクエストのみ**: エージェント発のリクエストをマスクする。レスポンス(サーバー→エージェント)は対象外
- **範囲はボディ + URL + ヘッダー**: リクエストの全要素を照合する。broker が注入する credential ヘッダーはマスク後に注入されるため影響を受けない
- **置換文字列は `****`(固定4文字)**: maskfs と異なり同一長置換にしない。Content-Length は mitmproxy が再計算するため長さ維持の必要がなく、固定長のほうが秘密値の長さも漏らさない
- **圧縮ボディは展開してマスク**: `Content-Encoding: gzip` 等は mitmproxy のデコード機能で展開→置換→再圧縮する。展開できないエンコーディングは生バイト列への照合にフォールバックする
- **percent-encoded バリアントも照合**: URL クエリと `application/x-www-form-urlencoded` ボディでは秘密値中の特殊文字が `%XX` 化されるため、生値に加えて `quote(secret)` / `quote_plus(secret)` の2バリアントを照合対象にする
- **base64 等の別エンコードは対象外**: 本機能は完全な DLP ではなく多層防御である。エージェントが base64 等で秘密値を再エンコードして送出する経路は検知できない
- **新しい設定項目は追加しない**: `mask.values` が非空かつ network proxy が有効なら自動的に有効になる
- **fail-closed**: 秘密値の解決失敗はセッション起動中止(maskfs と同方針)。最低4バイトガードも共通

## アーキテクチャ

秘密値は broker の decision 経由でアドオンに渡す(credential 注入 `injectHeaders` と同じ経路・同じ信頼境界)。
ディスクには書かない。

```
ProxyStage ──resolveMaskValues(ホスト側で解決)──> SessionBrokerService.start(maskValues)
    broker(メモリ保持) ──allow decision に maskValues を付与──> nas_addon.py(送出前に置換)
```

1. ProxyStage が `NetworkRuntimeService.resolveMaskValues` で秘密値を解決する(`resolveCredentials` と同型。maskfs と同じ `resolveSecret` + 最低4バイトガードを共用)
2. `SessionBrokerService.start` の config に `maskValues: string[]` を追加し、broker がメモリ保持する
3. broker は allow decision に `maskValues` を付与する(`DecisionResponse` に optional フィールド追加)
4. `nas_addon.py` は allow 受信後、credential 注入の前に URL・ヘッダー・ボディを置換する

### broker 側の reviewContext マスク

authorize リクエストの `reviewContext`(`bodyPreview`・`path`)はマスク前のボディから作られるため、秘密値を含み得る。
broker はメッセージ受信時に `reviewContext` を自前でマスクしてから処理する。
この一箇所で pending エントリ・監査ログ・レビュー UI・通知のすべてへの漏洩を塞ぐ。

## アドオンのマスク処理仕様

- 各秘密値につき照合パターンを3つ生成する: UTF-8 生バイト列、`quote(secret, safe="")`、`quote_plus(secret)`(重複は除去)
- 全パターンを**長い順**に並べ、逐次バイト置換する(部分重複対策)。置換文字列は `****`
- **URL**: `flow.request.path`(クエリ含む)への文字列置換
- **ヘッダー**: 各ヘッダー値への文字列置換。置換後に broker の `injectHeaders` を適用するため、注入 credential は影響を受けない
- **ボディ**: `flow.request.content`(Content-Encoding 展開済みバイト列)を置換して再代入する(mitmproxy が再圧縮と Content-Length 更新を行う)。展開に失敗する場合は `raw_content` への生バイト照合にフォールバックする
- マスクは review rule のマッチ有無に関係なく、allow されたすべての forward リクエストに適用する
- deny されたリクエストは送出されないためマスク不要

### スコープ外

- レスポンスボディ
- WebSocket メッセージ
- base64 等、percent-encoding 以外の再エンコードされた秘密値

## セキュリティ考慮

- 秘密値の経路はホスト(解決)→ broker メモリ → セッション別 UDS → プロキシコンテナのリクエスト処理スコープのみ。ディスクに書かれない。credential 注入が既に同じ経路で秘密値を運んでいる
- `bodyPreview` 経由でレビュー UI・監査ログに秘密値が載る既存の穴も、broker 側マスクで同時に塞がる
- アドオンスクリプトの変更は既存の addonHash 機構により共有プロキシコンテナの再作成を引き起こすため、旧アドオンが残留しない

## 変更点一覧

| ファイル | 変更 |
|---|---|
| `src/network/protocol.ts` | `DecisionResponse.maskValues?: string[]` 追加 |
| `src/network/broker.ts` | `maskValues` 保持、allow decision への付与、`reviewContext` の受信時マスク |
| `src/stages/proxy/session_broker_service.ts` | start config に `maskValues` 追加 |
| `src/stages/proxy/network_runtime_service.ts` | `resolveMaskValues` 追加(既存 `resolveCredentials` と同型) |
| `src/stages/proxy/stage.ts` | `planProxy` が `profile.mask` を plan に取り込み、`runProxy` が解決して broker へ渡す |
| `src/docker/mitmproxy/nas_addon.py` | マスク処理(純粋関数として切り出し) + request フックでの適用 |

## テスト計画

- **TS ユニットテスト**(既存 fake パターン、co-location):
  - broker: allow decision に `maskValues` が付くこと、`reviewContext` が pending エントリ・監査ログに入る前にマスクされること
  - `network_runtime_service`: `resolveMaskValues` の解決・fail-closed・4バイトガード
  - stage: mask 設定あり/なしで broker への受け渡しが切り替わること
- **Python 側**: マスク処理を `nas_addon.py` 内の純粋関数に切り出す。テストは python3 を spawn する統合テストで実行し(python3 不在時は skip)、`mitmproxy` モジュールはスタブを `PYTHONPATH` に置いて import を通す
- **e2e(任意)**: 既存の Docker e2e パターンで、プロキシ経由の POST がマスクされることをエコーサーバーで確認する
