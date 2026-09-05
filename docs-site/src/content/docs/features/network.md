---
title: ネットワーク制御
description: HTTP(S) の接続先とリクエストの許可設定
---

外部 API やパッケージ配布元への HTTP(S) 通信は `network.scopes` で許可します。まず接続先に一致する scope が選ばれ、その中のルールがメソッドやパスを判定します。既定では許可のない通信を拒否します。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

Claude Code 用の組み込みプリセットを指定する例です。プリセットに含まれない要求は拒否します。

```pkl
network {
  scopes {
    ["anthropic"] = (module.presets.anthropic.v1) {
      fallback = "deny"
    }
  }
}
```

`api.example.com:443` の `/v1/items/**` への GET だけを許可する例です。

```pkl
network {
  fallback = "deny"
  scopes {
    ["example-api"] {
      targets { "api.example.com:443" }
      fallback = "deny"
      rules {
        ["read-items"] {
          match { methods { "GET" }; paths { "/v1/items/**" } }
          onMatch = "allow"
        }
      }
    }
  }
}
```

`match` は「どのルールが担当するか」を選びます。受理済みのリクエストに必須の本文形状や値を求めるなら `expect` に置きます。条件を `match` に置くと、外れたリクエストは後続ルールや scope の fallback で許可される場合があります。

### 既存の通信設定への追加

`network.scopes` に新しい名前の scope を追加すると、共通設定から引き継いだ通信先も残ります。同じ名前の scope の中に設定を書けば、その通信先の設定を変更します。エージェントの API など、引き続き必要な通信先の設定は残してください。

同じファイルに `network` や `scopes` がすでにある場合は、既存のブロック内に追加します。

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `network.scopes` | 空 | 接続先ごとのルールのまとまり。複数一致時は、より具体的な接続先パターンを優先。 |
| `scope.rules` | 空 | メソッド、パス、任意の本文条件でリクエストを選ぶ。 |
| `onMatch` | — | 一致したリクエストを `"allow"`、`"review"`、`"deny"` にする。 |
| `onIndeterminate` | `"deny"` | 本文条件を判定できない場合を `"review"` または拒否にする。 |
| `scope.fallback` | `"deny"` | scope 内でルールが引き受けないリクエストの扱い。 |
| `network.fallback` | `"deny"` | scope に属さない接続先の扱い。 |
| `webSocket` | `"deny"` | HTTP Upgrade 後の WebSocket を許すか。 |

## 認証・承認・記録

### 秘密値とヘッダー

scope またはルールの `secrets` で、登録した秘密値の扱いを選びます。

| 値 | 動作 |
| --- | --- |
| `"inject"` | `inject` からの参照を許可。プロキシのマスクが有効なら、送信元の URL・ヘッダー・本文に現れた値もマスク。 |
| `"mask"` | 値を `****` に置換して送信。 |
| `"forbid"` | 値を含む要求を拒否。秘密値そのものは記録しない。 |
| `"ignore"` | 変更なし。 |

許可した要求にだけ、`inject` で `literal:`、`secret:`、`template:` のヘッダー値を追加できます。秘密の参照には、その scope / ルールで `"inject"` の指定が必要です。`mask.proxy = false` でも注入は有効ですが、送信元の URL・ヘッダー・本文の値はマスクされずに通る場合があります。

例えば、ホストの環境変数 `API_TOKEN` を使う場合は、上の `example-api` の設定と同じプロファイルに次を追加します。既存の GET・パス制限を残したまま、許可した要求の `Authorization` ヘッダーにだけ値を渡します。起動前にホスト側で `API_TOKEN` を設定してください。

```pkl
secrets {
  ["api-token"] { from = "env:API_TOKEN" }
}
network {
  scopes {
    ["example-api"] {
      secrets { ["api-token"] = "inject" }
      inject {
        new Inject {
          name = "Authorization"
          value = #"template:Bearer ${api-token}"#
        }
      }
    }
  }
}
```

設定を再信頼してセッションを起動し直し、認証を必要とする許可済みパスへの要求が成功することを確認します。トークンをコンテナの環境変数に渡す必要はありません。

### 承認待ち

`onMatch`、`onViolation`、`fallback` に `"review"` を指定すると承認待ちになります。`network.pendingTimeoutSeconds` の既定は 300 秒で、時間切れは拒否です。操作と再利用範囲は[通信・ホスト実行の承認](/nix-agent-sandbox/operations/approvals/)を参照してください。

<img src="/nix-agent-sandbox/images/network-prompt-ui.png" width="720" alt="通信先と要求内容を確認する承認カード" />

### 監査ログ

許可・拒否の記録は[監査ログ](/nix-agent-sandbox/operations/audit/)で確認できます。`requestBodyAudit.enable = true` は、秘密を含み得るマスク前のリクエスト本文もホストに保存する設定です。既定では本文を保存しません。

## 注意点

- 通信先、メソッド、パスを必要な範囲に限定してください。ヘッダー注入は、その通信先に秘密値を送る許可でもあります。
- Anthropic プリセットの既定の `fallback` は `"review"` です。未知の接続要求を拒否する場合は、設定例のように `"deny"` に変更します。既存の `expect` 条件は緩められません。
- WebSocket は既定で拒否します。許可した場合も、認可するのは接続開始時の HTTP Upgrade だけです。メッセージごとの承認はありません。
- 非 HTTP の TCP データは転送しません。HTTP 本文の必須条件は `expect` に指定します。

ホスト上のサービスへの到達も含め、[ネットワーク通信のリスク](/nix-agent-sandbox/security/risks/#network-egress)を参照してください。

## 関連ページ

- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) — 秘密値の扱いとマスクの設定
- [localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/) — コンテナからホストループバックサービスへ接続する経路
- [コンテナポート公開](/nix-agent-sandbox/features/port-bind/) — コンテナのサービスをホストループバックで開く逆方向の経路
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `NetworkConfig`、`Scope`、`Rule` の全定義
