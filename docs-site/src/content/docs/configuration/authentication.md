---
title: ホストの認証情報の利用
description: 秘密値の注入、Claude 認証情報の保持、エージェント設定ファイルの保護、廃止した設定ディレクトリ共有の移行先、Codex キーリングの選択
---

認証が必要な作業では、エージェント自身に値を読ませる必要があるかを先に決めます。値を渡さずに済む API 呼び出しやホストコマンドは、その実行時にだけ注入できます。

| 必要な作業 | 設定方法 |
| --- | --- |
| トークンを読ませず HTTP API を利用 | [許可した要求へのヘッダー注入](/nix-agent-sandbox/configuration/network/#認証ヘッダーと秘密値) |
| トークンを読ませずビルドなどを実行 | [ホストコマンドへの注入](/nix-agent-sandbox/configuration/host-commands/#秘密値付きのビルド) |
| ホストのクラウド CLI・GPG を利用 | [廃止した設定ディレクトリの共有](#廃止した設定ディレクトリの共有) |
| キーリングに保存済みの Codex 認証を利用 | [Codex のキーリング](#codex-のキーリング) |
| エージェントの設定ファイルをコンテナ内から書き換える | [エージェント設定ファイルの保護](#エージェント設定ファイルの保護) |
| API key で Claude や Codex を使う | [エージェントの認証情報の保持](#エージェントの認証情報の保持) |

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

## エージェントの認証情報の保持

`agentState.auth` は、エージェントのログイン情報をコンテナへどう渡すかを選びます。値は `"proxy"` と `"shared"` の2つで、指定しなければ既定値は Claude と Codex で `"proxy"`、Copilot で `"shared"` です。Dev Container の Codex は `"shared"` です。

文字列で書くと、起動するエージェントにも `extraAgents` のエージェントにも同じ値を使います。Copilot の認証情報は `~/.copilot` に無いので、`"proxy"` を指定しても `"shared"` として扱います。

```pkl
agentState {
  auth = "shared"
}
```

エージェントごとに変えるときは、エージェント名をキーにした Mapping で書きます。書かなかったエージェントは既定値になります。次は、Claude のプロファイルで `extraAgents { "codex" }` を使い、ホストの Codex が認証情報をキーリングに保存している例です。Claude の認証情報は `"proxy"` のままホストに残し、Codex だけを `"shared"` にします。

```pkl
extraAgents { "codex" }
agentState {
  auth = new Mapping { ["codex"] = "shared" }
}
```

Mapping で Copilot に `"proxy"` を指定すると、起動前の検証でエラーになります。

### Claude

`"proxy"` では、ホストの `~/.claude/.credentials.json` をコンテナと共有しません。コンテナから見えるのはセッションごとに作るダミーファイルで、実際のアクセストークンは書き込まれません。Claude Code が `api.anthropic.com` と `mcp-proxy.anthropic.com` へ送る通信は nas のプロキシが中継し、`Authorization` ヘッダーをホストのトークンで上書きしたうえで `x-api-key` ヘッダーを取り除きます。トークンの期限が近づいたときの更新もホストの nas が行い、コンテナ内では起きません。

ログインはホストで行ってください。コンテナ内で `/login` を実行しても、書き込まれる先はそのセッション限りのダミーファイルで、セッションの終了とともに消えます。ホストが未ログインの場合、セッションは起動せず、ホストで `claude /login` を実行するか `agentState.auth = "shared"` に切り替えるよう案内するメッセージが出ます。

API key で Claude を使うプロファイルには `agentState.auth = "shared"` を指定してください。`"proxy"` のまま `env` に `ANTHROPIC_API_KEY` や `ANTHROPIC_AUTH_TOKEN` を設定すると、起動前の検証でエラーになります。

#### `"proxy"` の制限

起動前の検証は、`env` の `ANTHROPIC_API_KEY` と `ANTHROPIC_AUTH_TOKEN` だけを調べます。
Bedrock（`CLAUDE_CODE_USE_BEDROCK`）、Vertex（`CLAUDE_CODE_USE_VERTEX`）、`apiKeyHelper`、`ANTHROPIC_BASE_URL` で指定するゲートウェイを使うプロファイルは検出できず、エラーになりません。
これらのプロファイルにも `agentState.auth = "shared"` を指定してください。

`"proxy"` では、コンテナの `~/.claude` はセッションごとに作るディレクトリで、ホストの `~/.claude` 直下にある項目を1つずつそこへマウントします。
ただし、次の2種類の項目はマウントしません。

- `.credentials.json`：ホストのファイルの代わりに、ダミーファイルをマウントします。
- シンボリックリンク（`agentState.protectSettings = false` のとき）：同じリンク先を指すシンボリックリンクをセッションのディレクトリに作ります。リンク先はコンテナ内で解決するので、リンク先がコンテナにマウントされていなければ、コンテナからはたどれません。

セッション開始時にホストにある項目は読み書き可能で、変更はホストに残ります。
セッション中に Claude がコンテナ内で `~/.claude` 直下に新しく作った項目は、ホストには作られず、セッションの終了とともに消えます。
たとえば、初めての `/plugin install` が作る `plugins/` は、ホストに残りません。
残したい項目は、先にホストで作成するか、ホストの Claude Code で操作してください。
`agentState.protectSettings` を有効にしたときの扱いは、[エージェント設定ファイルの保護](#エージェント設定ファイルの保護)の表のとおりです。

### Codex

`"proxy"` では、ホストの `~/.codex` を今までどおり共有したうえで、`~/.codex/auth.json` の位置にだけセッションごとのダミーファイルを被せます。ダミーには実際のトークンは入っていません。Codex が `chatgpt.com` の `/backend-api/` の下へ送る通信は nas のプロキシが中継し、`Authorization` と `chatgpt-account-id` をホストの値で上書きします。`chatgpt.com` の他の path への通信にはホストの値を付けません。トークンの更新はホストの nas が行い、コンテナ内では起きません。

ログインはホストで `codex login` を実行してください。ホストの `~/.codex/auth.json` に ChatGPT のログイン情報が無い場合、セッションは起動しません。次の場合は `agentState.auth = "shared"` を指定してください。

- API key で Codex を使う（`"proxy"` のまま `env` に `OPENAI_API_KEY` や `CODEX_API_KEY` を設定すると、起動前の検証でエラーになります）
- ホストの Codex が認証情報をキーリングに保存している（`cli_auth_credentials_store = "keyring"`。[Codex のキーリング](#codex-のキーリング)の設定を使います）

#### `"proxy"` の制限

- セッションの実行中にホストの `~/.codex/auth.json` が削除されるか別のファイルに置き換わると、nas はそのセッションのコンテナを停止します。ホストでの `codex logout` がこれにあたります。ファイルが別のファイルに置き換わった場合（rename）は、停止するまでの短い間、新しいファイルがコンテナから見えます。
- ホストの Codex と nas が同時にトークンを更新すると、片方が失敗することがあります。nas はホストの Codex が更新したファイルを読み直して回復します。ホストの Codex が失敗した場合は、ホストで再ログインが必要になることがあります。
- コンテナ内で `codex login` を実行しても、書き込まれる先はそのセッション限りのダミーファイルで、セッションの終了とともに消えます。

## エージェント設定ファイルの保護

`agentState.protectSettings` を有効にすると、ホストから共有する設定をコンテナ内で書き換えられなくなります。既定は無効です。

```pkl
agentState {
  protectSettings = true
}
```

Claude では、ホストの設定・plugins・skills・agents・commands・hooks などを読み取り専用で共有します。`~/.claude/sumi/` に置いた secrets file も対象です。共有範囲は通常起動・ACP・Dev Container で共通です。

| Claude の保存先 | 扱い |
| --- | --- |
| `~/.claude.json` | 読み書き可能で共有 |
| `~/.claude/.credentials.json` | `agentState.auth = "proxy"`（既定）ならダミーファイルを見せ、ホストの実体とは共有しない。`"shared"` なら読み書き可能で共有 |
| `~/.claude/history.jsonl`、`projects/`、`file-history/` | 読み書き可能で共有。`projects/` 内の auto memory も含む |
| ログ・キャッシュ・shell snapshots | セッション専用。終了時に削除 |
| その他の `~/.claude/` 直下の項目 | ホストにあれば読み取り専用で共有。なければセッション専用 |

履歴・プロジェクトなど共有先がなければ、起動時に作成します。`~/.claude/.credentials.json` も `agentState.auth = "shared"` のときは同様に、なければ作成したうえで共有します。ホストの設定変更や既存 plugin の更新はホストで行ってください。コンテナ内からの更新は読み取り専用のため失敗します。

Codex / Copilot は状態ディレクトリを読み書き可能で共有し、次の実在する設定ファイルだけを読み取り専用にします。

| エージェント | 読み取り専用にするファイル |
| --- | --- |
| codex | `~/.codex/config.toml` |
| copilot | `~/.copilot/config.json`、`~/.copilot/mcp-config.json` |

Codex の `~/.codex/auth.json` は、`agentState.auth = "proxy"`（既定）ならダミーファイルを見せ、ホストの実体とは共有しません。

### 保護しないもの

`~/.claude.json` は Claude が実行中に更新するため、読み書き可能で共有します。ここに追加された MCP サーバーの起動も防ぐには、ホスト・コンテナの両方に次の [managed settings](https://code.claude.com/docs/en/managed-mcp#restrict-the-allowlist-to-managed-settings-only) を配置します。nas が自動で追加する設定ではありません。

```json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": []
}
```

作業フォルダーの `.claude/settings.json`、`.git/hooks`、`.github/hooks/` は保護しません。信頼できないリポジトリでは、ホストでそのフォルダーの hooks が動く操作をする前に中身を確認してください。

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
hostexec = new HostExecConfig {
  rules {
    new {
      id = "gpg-git-sign"
      match {
        argv0 = "gpg"
        argRegex = "^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$"
      }
      cwd { mode = "workspace-or-session-tmp" }
      approval = "allow"
    }
  }
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
