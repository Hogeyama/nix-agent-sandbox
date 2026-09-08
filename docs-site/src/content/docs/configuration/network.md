---
title: 外部への通信許可
description: 必要な API・配布元の追加、実行時の承認、認証ヘッダー、ツール側のプロキシ設定
---

必要な API やパッケージ配布元が拒否されたら、接続先と要求を確認して、使用中のプロファイルへ許可を追加します。通信は既定で拒否されます。実行時に人が判断する要求は承認待ちにできます。

## 接続先の追加

まず [UI の Audit](/nix-agent-sandbox/work/troubleshooting/#許可拒否の記録)やツールのエラーで、拒否されたホストとポートを確認します。使用する API のメソッドとパスも確認し、[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)に設定します。以下は `api.example.com:443` の `/v1/items/**` への GET を許可する例です。

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

接続先のまとまりを **scope**、その中の要求の条件を **rule** と呼びます。接続先に一致する scope が選ばれ、その中でメソッドやパスを判定します。複数の scope に一致した場合は、より具体的な接続先パターンが優先されます。

既存の network / scopes があれば、その中に `example-api` のような新しい名前を追加します。共通設定から引き継いだ通信先は残ります。同じ名前ならその scope の変更になるので、エージェントの API など必要な許可を消さないでください。

設定を確認して `nas config trust` を実行し、変更したプロファイルで起動し直します。対象の要求を行い、期待する結果が返ることと UI の判定を確認します。

### 別のエージェント用の設定

生成された claude と codex は別のプロファイルです。Codex を使う場合は codex 側に追加して `nas codex`、Copilot 用なら `agent = "copilot"` を指定したプロファイルを選びます。上の接続先は例なので、そのままエージェントの API には使えません。

起動後の通信が拒否されたら、そのセッションの Audit で接続先を確認し、同じ追加手順を使います。認証を保存しただけでは通信許可にはなりません。

### Claude Code の組み込み設定

Claude Code には組み込みの通信プリセットがあります。次は含まれない要求を拒否する指定です。

```pkl
network {
  scopes {
    ["anthropic"] = (module.presets.anthropic.v1) {
      fallback = "deny"
    }
  }
}
```

プリセット自体の fallback は review です。未知の要求を拒否する場合は上のように deny にします。プリセットにある受理条件は緩められません。

## 自動許可と承認待ち

`onMatch = "allow"` は一致した要求を自動で許可します。`"review"` に変えると UI の Pending で判断する要求になり、`"deny"` なら拒否します。

| 条件 | 指定場所 |
| --- | --- |
| ルールに一致した要求 | `onMatch` |
| 本文の受理条件に違反 | `onViolation` |
| 本文条件を判定できない | `onIndeterminate`（既定は deny） |
| scope 内で引き受けるルールがない | scope の `fallback`（既定は deny） |
| 接続先に一致する scope がない | network の `fallback`（既定は deny） |

review の要求は[UI で内容と範囲を確認して許可・拒否](/nix-agent-sandbox/work/approvals/)します。`network.pendingTimeoutSeconds` の既定は300秒で、時間切れは拒否です。deny の要求は Pending には出ません。

## localhost のポート転送

プロファイルには、新しいセッションで最初から必要な TCP 転送を設定できます。どちらも `127.0.0.1` だけを使い、`hostPort` と `containerPort` は 1〜65535 の整数を明示します。

| 設定 | 待受 | 接続先 | 用途 |
| --- | --- | --- | --- |
| `localForwards` | ホストの `hostPort` | コンテナの `containerPort` | 開発サーバーをホストで確認する |
| `remoteForwards` | コンテナの `containerPort` | ホストの `hostPort` | ホストの DB・API をコンテナから使う |

```pkl
network {
  localForwards {
    new PortForwardConfig { hostPort = 8080; containerPort = 3000 }
  }
  remoteForwards {
    new PortForwardConfig { hostPort = 5432; containerPort = 15432 }
  }
}
```

設定は新しいセッションの初期値です。設定由来の転送も実行中に UI または `nas network unbind` で解除できます。解除は現在のセッションだけに適用され、リレーが再接続しても戻りません。プロファイルを変えなければ、次の新しいセッションでは再び適用されます。

旧 `network.proxy.forwardPorts` も同じ番号の Remote 転送として引き続き動きますが、非空の場合は移行の警告が出ます。リポジトリの `docs/migration/port-forwarding.md` にある置き換え手順を参照してください。

作業中の追加・解除は、方向に応じて[開発サーバーの確認](/nix-agent-sandbox/work/preview/)または[ホストの DB・API への接続](/nix-agent-sandbox/configuration/host-services/)を参照してください。

### ルールの選択条件と必須条件

`match` はどのルールが担当するかを選びます。必ず満たしてほしい本文の形や値は `expect` に置きます。match にだけ置くと、外れた要求が後続ルールや fallback で許可される場合があります。

WebSocket は既定で拒否します。許可した場合も認可は接続開始時の HTTP Upgrade だけで、その後のメッセージごとの承認はありません。非 HTTP の TCP 通信は、このプロキシでは転送しません。

## 認証ヘッダーと秘密値

トークンをコンテナに渡さず API 認証に使う場合は、許可した要求へヘッダーを注入します。**ヘッダー注入は、その接続先へ秘密値を送る許可でもあります。** 先にホスト、メソッド、パスの範囲を確認してください。

ホストの環境変数 API_TOKEN を取得し、上の example-api の Authorization に渡す例です。起動前にホストで API_TOKEN を設定し、同じプロファイルへ追加します。

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

GET とパスの条件はそのまま残ります。再信頼して起動し、認証が必要な許可済みパスへの要求が成功することを確認します。取得元を変える場合は[名前付き秘密](/nix-agent-sandbox/configuration/authentication/#秘密値の取得元)を参照してください。

scope または rule の secrets は、その通信での値の扱いを指定します。

| 値 | 扱い |
| --- | --- |
| `inject` | ヘッダーからの参照を許可。プロキシマスクが有効なら送信元の URL・ヘッダー・本文に現れた値もマスク。 |
| `mask` | `****` に置換して送信。 |
| `forbid` | 値を含む要求を拒否。秘密値そのものは記録しない。 |
| `ignore` | 変更しない。 |

注入には `literal:`、`secret:`、`template:` を使えます。秘密を参照する場合は inject の指定が必要です。`mask.apply` はファイル表示と出力フィルターの対象で、通信の選択には使いません。

`mask.proxy = false` でも注入は有効ですが、送信元の値はマスクされず通る場合があります。また、通信側に mask / forbid は残せません。既定の `network.defaults.secrets["*"]` は mask なので、プロキシマスクを無効にする構成では ignore の明示も必要です。

## ツール側のプロキシ設定

Gradle などがプロキシ環境変数を使わない場合は、JVM プロパティで `127.0.0.1:18080` を指定します。プロキシへの接続設定と、外部の配布元の通信許可は別に必要です。

次は GRADLE_OPTS と services.gradle.org への GET 許可を追加する例です。実際に使う配布元やリダイレクト先も追加してください。既存の env や network がある場合は、その項目を残して追加します。

```pkl
env = new Listing {
  new EnvConfig {
    key = "GRADLE_OPTS"
    val = "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080 -Dhttp.nonProxyHosts=localhost|127.0.0.1"
  }
}
network {
  fallback = "deny"
  scopes {
    ["gradle-services"] {
      targets { "services.gradle.org:443" }
      fallback = "deny"
      rules {
        ["downloads"] {
          match { methods { "GET" }; paths { "/**" } }
          onMatch = "allow"
        }
      }
    }
  }
}
```

Maven では同じ JVM プロパティを MAVEN_OPTS に設定できます。これらはコンテナに渡る環境変数なので、秘密値を含めないでください。18080 は内部プロキシ用の予約ポートで、ホストサービスの転送先には追加しません。

通信に含まれる本文を調査のため保存する場合は、[記録と保存期間](/nix-agent-sandbox/configuration/recording/#通信本文の追加保存)を確認します。
