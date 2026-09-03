---
title: proxy 環境変数を参照しないツール
description: JVM ツールへ localhost proxy を明示しつつ network 認可を維持する
---

## 得られること

標準の proxy 環境変数を読まない Gradle に、コンテナ内の nas proxy
`127.0.0.1:18080` を JVM property として渡します。通信の宛先・HTTP request を許可する
仕組みは変えず、[ネットワーク制御](/nix-agent-sandbox/features/network/) の scope と rule が
引き続き認可します。

## 前提

- Gradle または別の JVM ツールが proxy 環境変数を無視する。
- 必要な target と request を `network.scopes` に明示している。
- `18080` は nas 内部 proxy 用の予約済みポートであり、`forwardPorts` に追加しない。

```pkl
amends "Schema.pkl"

profiles {
  ["android"] {
    agent = "claude"
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
  }
}
```

## 権限と注意点

この設定は Gradle の接続先を新たに許可しません。プロパティは接続を nas proxy に
向けるだけで、proxy の先では `gradle-services` scope の target、`downloads` rule の
GET、scope の deny fallback が適用されます。`network.fallback = "deny"` なので、この
scope 外の target も拒否されます。

`GRADLE_OPTS` はエージェントが起動する Gradle に渡る通常の環境変数です。秘密を値に
含めず、認証が必要なら [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) と
network の named-secret injection を使ってください。Maven なら同じ property 列を
`MAVEN_OPTS` に設定できます。

この `onMatch = "allow"` は `services.gradle.org:443` への GET を外向きに許可します。target、path、method を広げる前に、[network egress のリスク](/nix-agent-sandbox/security/risks/#network-egress)を確認してください。

## 関連ページ

- [ネットワーク制御](/nix-agent-sandbox/features/network/)
- [localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/)
- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/)
