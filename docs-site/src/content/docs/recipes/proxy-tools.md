---
title: Gradle・Maven のプロキシ設定
description: JVM プロパティによるプロキシ指定と通信許可
---

Gradle がプロキシ環境変数を使わない場合は、JVM プロパティで nas のプロキシ `127.0.0.1:18080` を指定します。Maven では同じ値を `MAVEN_OPTS` に設定できます。

## 前提条件

[クイックスタート](/nix-agent-sandbox/getting-started/quick-start/)などでエージェントと通信できる状態にしておきます。

## 設定例

エージェントとの通信を設定済みの `claude` プロファイルに、以下の設定を追加します。編集先は[プロファイルの編集](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)を参照してください。既存の設定項目がある場合は、その中に要素を追加し、通信先やルールを残してください。

この例は `services.gradle.org:443` への GET を許可します。実際のダウンロードで必要な配布元やリダイレクト先も、[ネットワーク制御](/nix-agent-sandbox/features/network/)に従って追加してください。

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

設定を確認して `nas config trust` を実行し、`nas claude` で起動します。

## 注意点

プロキシを指定する JVM プロパティと、通信を許可する `network.scopes` は別の設定です。指定した scope 以外の接続先は拒否します。

`18080` は内部プロキシ用の予約ポートです。`forwardPorts` には追加しません。

`GRADLE_OPTS` と `MAVEN_OPTS` はコンテナに渡る環境変数です。秘密値は含めず、認証が必要なら[秘密値のヘッダー注入](/nix-agent-sandbox/features/network/#秘密値とヘッダー)を使います。
