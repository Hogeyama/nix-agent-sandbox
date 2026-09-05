---
title: Codex のキーリング
description: DBus 経由の Codex 認証情報の共有
---

ホストのキーリングに保存した Codex の認証情報を、コンテナから利用する設定です。DBus の Secret Service への呼び出しを、3 つのメソッドに限定します。

## 前提条件

- エージェントの API への通信許可を設定済み。Claude Code の例は[クイックスタート](/nix-agent-sandbox/getting-started/quick-start/)を参照。

- ホストの Codex 設定が `cli_auth_credentials_store = "keyring"` で、認証情報を保存済み。
- ホストで Secret Service、セッションバス、`xdg-dbus-proxy` が利用可能。

## 設定例

エージェントとの通信を設定済みの `codex` プロファイルに、以下の設定を追加します。編集先は[プロファイルの編集](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)を参照してください。既存の設定項目がある場合は、その中に要素を追加し、通信先やルールを残してください。

```pkl
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
```

設定を確認して `nas config trust` を実行し、`nas codex` で起動します。

## 権限の範囲

許可するのは `OpenSession`、`SearchItems`、`GetSecret` です。他のサービスやメソッドを使う必要がなければ、`talk`、`see`、`broadcasts`、`rule = "*"` は追加しません。

この制限は取得対象を Codex の認証情報だけに絞るものではありません。Secret Service がホストユーザーに認める範囲で、検索に一致した他の秘密値も取得できます。[DBus のリスク](/nix-agent-sandbox/security/risks/#dbus)を確認してください。
