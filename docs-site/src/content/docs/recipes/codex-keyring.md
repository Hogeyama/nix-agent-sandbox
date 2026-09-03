---
title: Codex の keyring
description: Secret Service の必要なメソッドだけを filtered DBus proxy 経由で渡す
---

## 得られること

Codex の `cli_auth_credentials_store = "keyring"` が、コンテナに session bus 全体を
渡さず、Secret Service の認証情報を読むための 3 メソッドだけを使えます。

## 前提

- ホストの Codex 設定で credential store を `keyring` にしている。
- ホストの session bus と `xdg-dbus-proxy` が利用できる。
- ホストに Secret Service provider があり、Codex の credential を保存済みである。

```pkl
amends "Schema.pkl"

profiles {
  ["codex"] {
    agent = "codex"
    dbus {
      session {
        enable = true
        calls = new Listing {
          new DbusRuleConfig {
            name = "org.freedesktop.secrets"
            rule = "org.freedesktop.Secret.Service.OpenSession"
          }
          new DbusRuleConfig {
            name = "org.freedesktop.secrets"
            rule = "org.freedesktop.Secret.Service.SearchItems"
          }
          new DbusRuleConfig {
            name = "org.freedesktop.secrets"
            rule = "org.freedesktop.Secret.Item.GetSecret"
          }
        }
      }
    }
  }
}
```

## 権限と注意点

nas は host session bus の代わりに、per-session の filtered proxy socket だけを
コンテナへ渡します。この例は `org.freedesktop.secrets` の任意呼び出しや他 service の
利用を許さず、列挙した `OpenSession`、`SearchItems`、`GetSecret` だけを許可します。

それでも `SearchItems` と `GetSecret` を許したことは、service がこのユーザーに既に
認めている一致 item とその secret value を Codex が取得できる、という権限です。DBus
filter は Secret Service 自身の access control を狭めず、その service が保持する
authority は許可した呼び出しを通じて到達可能です。必要のない `talk`、`see`、
`broadcasts`、広い `rule = "*"` は追加しないでください。

この filtered socket が到達させる resource は、[DBus のリスク](/nix-agent-sandbox/security/risks/#dbus)を参照してください。

## 関連ページ

- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/)
- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/)
