---
title: ネットワーク制御
description: target scope と request rule による HTTP(S) 通信の認可
---

## どんな機能？

ネットワーク認可は二段階です。`network.scopes` が接続先 target を 1 つの scope に選び、scope 内の `rules` が HTTP リクエストを選びます。target 選択と request 受理を混ぜないことで、どのホストに出せるかと、そのホストで何を送れるかを別々に絞れます。旧来の flat allowlist と prompt 構成は現行スキーマで受け付けません。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `network.scopes` | 空 | target パターンごとの認可境界。より特異な target が選ばれる。 |
| `scope.rules` | 空 | method、path、任意の body 条件で request を選ぶ。 |
| `onMatch` | — | 一致した request を `"allow"`、`"review"`、`"deny"` にする。 |
| `onIndeterminate` | `"deny"` | body 条件を判定できない場合を `"review"` または拒否にする。 |
| `scope.fallback` | `"deny"` | scope 内で rule が引き受けない request の扱い。 |
| `network.fallback` | `"deny"` | scope に属さない target の扱い。 |
| `webSocket` | `"deny"` | HTTP Upgrade 後の WebSocket を許すか。 |

## 最小の設定例

Claude Code 用には、不変の組み込み preset を scope として割り当てます。preset の fallback は `"review"` です。未知の endpoint を approval で開けたくない構成では、Schema が示すように同じ scope を amend して `"deny"` にします。

```pkl
network {
  scopes {
    ["anthropic"] = (module.presets.anthropic.v1) {
      fallback = "deny"
    }
  }
}
```

独自 API では、scope が target を、rule が request を選びます。

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

`match` は「どの rule が担当するか」を選びます。受理済みの request に必須の body 形状や値を求めるなら `expect` に置きます。条件を `match` に置くと、外れた request はより広い rule や scope の fallback へ進めます。

## 秘密、注入、承認、監査

scope または rule の `secrets` では、名前付き秘密を `"inject"`、`"mask"`、`"forbid"`、`"ignore"` として扱えます。`"inject"` は `inject` の参照を許し、proxy masking が有効なときは body・URL・client 由来 header に現れた値を `"mask"` と同じく伏せます。`mask.proxy = false` では inject 自体は有効ですが、それらの出現は unmasked で通り得ます。`"mask"` は出現を `****` に置換して送出し、`"forbid"` は出現した request を拒否して値そのものを記録しません。`"ignore"` は変更しません。許可された request にだけ `inject` で `literal:`、`secret:`、`template:` のヘッダー値を付けられます。`secret:` と template 内の参照には、その scope / rule で `"inject"` の秘密が必要です。

`onMatch = "review"`、`onViolation = "review"`、または `fallback = "review"` は承認待ちを作ります。`network.pendingTimeoutSeconds` の既定は 300 秒で、時間切れは拒否です。通常の request / fallback review は `once` のほか、target を単一の正確な host:port に固定する scope では `rule`、それ以外では `host-port` または `host` を選べます。再利用の同一性は rule ID・判定理由・target であり、scope fallback は `$fallback` という擬似 rule ID を使うため path は含みません。`expect` 違反の review は別で、`once` または `violation` を選び、rule ID・expect の位置・違反値で再利用されて target は含みません。

`requestBodyAudit.enable = true` はマスク前の正確な request body をホストの監査 DB に保存しようとします。既定は保存しません。capture が読めない、body が大きすぎる、容量上限、入力不正、store failure の場合は `unavailable` 状態を記録し、認可処理は続きます。必要性、保持期間、最大容量を確認してから有効にしてください。

## 注意点・セキュリティへの影響

- `network.scopes` の target と rule、`onMatch = "allow"` / `"review"`、scope / network fallback、`webSocket = "allow"` は、外向き通信と approval の再利用範囲を広げます。許可 rule の `inject` header はその upstream へ secret を送る capability でもあります。最小の target、method、path、header に絞り、[network egress のリスク](/nix-agent-sandbox/security/risks/#network-egress)を確認してください。
- Anthropic preset は配布物で上書きされる不変の scope です。既知の endpoint と body 条件を狭めており、既存の `expect` を緩めることはできません。既定の `fallback = "review"` を残す場合、fallback の再利用承認は path を含みません。endpoint を足すときは同じ scope を amend します。
- WebSocket は既定で拒否です。`webSocket = "allow"` でも opening HTTP Upgrade だけが通常の rule / fallback で一度認可されます。メッセージごとの review は行いません。
- raw TCP は scope ごとの HTTP rule の対象ではなく、非 HTTP の tunnel bytes は上流へ転送されません。HTTP の body 構造を保証したい場合は `expect` を使います。

mask 前の body を host に保存する opt-in の範囲と retention は、[request-body audit のリスク](/nix-agent-sandbox/security/risks/#request-body-audit)を参照してください。

<img src="/nix-agent-sandbox/images/network-prompt.png" width="720" alt="ネットワーク request の承認画面。対象、rule、要求内容を確認してから判断する。" />

<img src="/nix-agent-sandbox/images/network-prompt-ui.png" width="720" alt="UI daemon のネットワーク承認カード。pending の request ごとに許可または拒否できる。" />

スクリーンショットは review の操作例です。承認範囲は設定した rule、違反、fallback により決まるため、先に scope と rule を狭めます。

## 関連ページ

- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) — secret disposition と mask の設定
- [localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/) — コンテナから host loopback service へ接続する経路
- [コンテナポート公開](/nix-agent-sandbox/features/port-bind/) — コンテナの service を host loopback で開く逆方向の経路
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `NetworkConfig`、`Scope`、`Rule` の全定義
