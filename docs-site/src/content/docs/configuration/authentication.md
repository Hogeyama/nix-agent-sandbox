---
title: ホストの認証情報の利用
description: 秘密値の注入、クラウド設定の共有、GPG と Codex キーリングの選択
---

認証が必要な作業では、エージェント自身に値を読ませる必要があるかを先に決めます。値を渡さずに済む API 呼び出しやホストコマンドは、その実行時にだけ注入できます。

| 必要な作業 | 設定方法 |
| --- | --- |
| トークンを読ませず HTTP API を利用 | [許可した要求へのヘッダー注入](/nix-agent-sandbox/configuration/network/#認証ヘッダーと秘密値) |
| トークンを読ませずビルドなどを実行 | [ホストコマンドへの注入](/nix-agent-sandbox/configuration/host-commands/#秘密値付きのビルド) |
| ホストの gcloud・AWS 設定をそのまま利用 | [クラウドの認証設定](#クラウドの認証設定) |
| ホストの GPG エージェントで署名・復号 | [GPG エージェント](#gpg-エージェント) |
| キーリングに保存済みの Codex 認証を利用 | [Codex のキーリング](#codex-のキーリング) |

## 秘密値の取得元

ヘッダー注入やマスクには、値を設定へ直接書く代わりに、secrets に名前と取得元を登録します。値はホストで取得します。

```pkl
secrets {
  ["api-token"] { from = "env:API_TOKEN"; required = true }
}
```

[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)の設定です。required の既定は true で、取得できなければ起動を中止します。通常の env に値を直接書くと、そのままコンテナに渡るので使い分けてください。

| from の形式 | 取得元 |
| --- | --- |
| `env:VAR` | ホストの環境変数 |
| `file:/path` | ホストのファイル |
| `dotenv:/path#KEY` | dotenv ファイルの指定キー |
| `keyring:service/account` | キーリングのサービス・アカウント |
| `lines:/path` | ファイルの非空行を、それぞれ別の値として取得 |
| `cmd:<command>` | ホストで sh -c を実行し、標準出力の最初の行を取得 |

lines は複数の値になるため、ヘッダー注入や単一値のホスト実行環境変数には使えません。cmd はホストで動くので、エージェントが変更できる文字列やスクリプトを指定しないでください。

登録だけではファイル表示や出力はマスクされません。値を読ませないための設定は[ファイルの非公開・マスク](/nix-agent-sandbox/configuration/files/)にあります。

## クラウドの認証設定

クラウド CLI がホストと同じ認証設定を使う必要がある場合は、使用するプロファイルで共有を有効にします。**設定ディレクトリを読み書き可能で渡すため、エージェントは認証情報を読み、ホスト側の設定を変更・削除できます。** 注入で足りる作業なら、その方法を先に検討してください。

```pkl
gcloud { mountConfig = true }
aws { mountConfig = true }
```

必要なサービスの行だけを追加します。共有先は gcloud の `~/.config/gcloud`、AWS の `~/.aws` です。再信頼して起動し、コンテナ内の CLI で意図したアカウントを利用できるか確認します。

## GPG エージェント

ホストの gpg-agent を使わせるには、対象プロファイルで `gpg.forwardAgent = true` を指定します。ソケットと関連設定を共有し、署名・復号が可能になります。公開鍵を読めるようにするだけの設定ではありません。

## Codex のキーリング

ホストの Codex が `cli_auth_credentials_store = "keyring"` を使い、認証情報を保存済みの場合の設定です。ホストで Secret Service、セッションバス、`xdg-dbus-proxy` が利用できる必要があります。

次の設定は Secret Service の OpenSession、SearchItems、GetSecret を許可します。**取得対象を Codex の認証情報だけに限定するものではありません。** ホストユーザーに認められる範囲で、検索に一致した他の秘密も取得できます。

codex プロファイルへ追加します。既存の DBus 設定があれば必要な項目を残し、呼び出しの許可を追加してください。

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

設定を確認して `nas config trust` を実行し、`nas codex` で起動します。保存済みの認証を使えることを確認してください。Claude 用の通信設定は Codex には適用されません。API 通信が未許可なら、UI の Audit で接続先を確認して[Codex 用プロファイルの通信許可](/nix-agent-sandbox/configuration/network/#別のエージェント用の設定)を追加します。

ホストの UID や xdg-dbus-proxy がなければ DBus 有効化は省略されます。DBUS_SESSION_BUS_ADDRESS が未設定なら `unix:path=/run/user/$UID/bus` を使いますが、バスが利用できなければ起動に失敗します。

必要なサービスやメソッドが増えない限り、talk、see、broadcasts、`rule = "*"` を追加して許可を広げないでください。
