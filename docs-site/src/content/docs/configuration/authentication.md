---
title: ホストの認証情報の利用
description: 秘密値の注入、エージェント設定ファイルの保護、廃止した設定ディレクトリ共有の移行先、Codex キーリングの選択
---

認証が必要な作業では、エージェント自身に値を読ませる必要があるかを先に決めます。値を渡さずに済む API 呼び出しやホストコマンドは、その実行時にだけ注入できます。

| 必要な作業 | 設定方法 |
| --- | --- |
| トークンを読ませず HTTP API を利用 | [許可した要求へのヘッダー注入](/nix-agent-sandbox/configuration/network/#認証ヘッダーと秘密値) |
| トークンを読ませずビルドなどを実行 | [ホストコマンドへの注入](/nix-agent-sandbox/configuration/host-commands/#秘密値付きのビルド) |
| ホストのクラウド CLI・GPG を利用 | [廃止した設定ディレクトリの共有](#廃止した設定ディレクトリの共有) |
| キーリングに保存済みの Codex 認証を利用 | [Codex のキーリング](#codex-のキーリング) |
| エージェントの設定ファイルをコンテナ内から書き換える | [エージェント設定ファイルの保護](#エージェント設定ファイルの保護) |

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

## エージェント設定ファイルの保護

ホストの `~/.claude`・`~/.codex`・`~/.copilot` は、認証情報とセッション履歴を持ち込むため読み書き可能で共有します。`agentState.protectSettings` を有効にすると、そのうち設定ファイルだけを読み取り専用に上書きします。既定は無効です。

| エージェント | 読み取り専用にするファイル |
| --- | --- |
| claude | `~/.claude/settings.json`、`~/.claude/settings.local.json` |
| codex | `~/.codex/config.toml` |
| copilot | `~/.copilot/config.json`、`~/.copilot/mcp-config.json` |

これらは hooks や MCP サーバとして、ホストで同じエージェントを起動したときにホスト上で実行されるコマンドを宣言します。コンテナ内のエージェントが書き換えられると、次にホストでエージェントを起動した瞬間にホストで任意のコマンドが動きます。対象はホストに実在するファイルだけで、まだ設定ファイルが無いホストでは何も追加されません。

この経路を塞ぐには、対象プロファイルで有効にします。

```pkl
agentState {
  protectSettings = true
}
```

有効にすると、コンテナ内からこれらのファイルに書き込むツール（VS Code 拡張など）はエラーになります。既定で無効にしているのはこのためです。ホスト側の設定を変えたいだけなら、コンテナ内ではなくホストで編集してください。

### 保護しないもの

保護の対象は、エージェントが実行中に書き換えないユーザー単位の設定ファイルに限ります。次のものは同じ経路を持ちますが対象外です。

- `~/.claude.json` — `mcpServers` を持ちますが、claude が実行中に書き換えるため読み取り専用にできません。
- 作業フォルダーの `.claude/settings.json`、`.git/hooks`、`.github/hooks/` — エージェントが編集する対象と同じツリーにあります。信頼できないリポジトリでは、ホストでそのフォルダーの hooks が動く操作をする前に中身を確認してください。

## 廃止した設定ディレクトリの共有

`gcloud.mountConfig`、`aws.mountConfig`、`gpg.forwardAgent` は廃止しました。設定を残したまま起動すると、移行先を示すエラーで停止します。

いずれも資格情報の置き場ごとコンテナへ渡す設定でした。`~/.config/gcloud` と `~/.aws` は読み書き可能で渡っていたため、エージェントはそこにある全プロファイルを読めて、ホスト側の設定を書き換えられました。gpg-agent のソケットは、ホストが持つ鍵すべてでの署名・復号を、利用のたびの確認なしに許すものでした。いずれも、作業に必要な範囲をはるかに超えて渡しています。

代わりに、必要な場所へ必要なものだけを渡します。

| 必要な作業 | 移行先 |
| --- | --- |
| クラウド API の呼び出し | [許可した要求へのヘッダー注入](/nix-agent-sandbox/configuration/network/#認証ヘッダーと秘密値) |
| クラウド CLI やビルドの実行 | [ホストコマンドへの移譲](/nix-agent-sandbox/configuration/host-commands/) |
| コミットへの GPG 署名 | [ホストコマンドへの移譲](/nix-agent-sandbox/configuration/host-commands/) |

署名をホストへ移譲する場合は、`gpg` の呼び出しのうち通す形を hostexec のルールで固定します。次は `git commit -S` が出す形だけを許す例です。

```pkl
new {
  id = "gpg-git-sign"
  match {
    argv0 = "gpg"
    argRegex = "^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$"
  }
  cwd { mode = "workspace-or-session-tmp" }
  approval = "allow"
}
```

移譲でも注入でも足りず、どうしてもホストのファイルが要る場合は、ディレクトリ全体ではなく必要なパスだけを [extraMounts](/nix-agent-sandbox/configuration/files/) で `mode = "ro"` を指定して渡してください。

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
