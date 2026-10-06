# strait

strait は、Claude Code などのコーディングエージェントを、Anthropic の [srt](https://github.com/anthropics/sandbox-runtime) のサンドボックスで動かすツールです。srt を CLI ではなくライブラリとして使い、その上に次の機能を加えています。

## strait が加える機能

ネットワークの制限は、サンドボックスの外で動く strait のプロキシと、srt のファイルシステムの設定が適用します。エージェントの判断には依存しません。

### 認証情報の上書き

srt の CLI は、サンドボックス内の認証情報をダミーの値にしておき、プロキシでダミーの値を本物に戻します。戻すのはダミーの値だけなので、サンドボックス内のプログラムが別のトークンを付けた要求は、そのまま上流に届きます。例えば、攻撃者のトークンで攻撃者のリポジトリに push すれば、コードを持ち出せます。

strait は、許可・承認した要求の認証ヘッダーを、クライアントが何を付けたかにかかわらず、ホスト側の認証情報で上書きします。上流に届くのは常にホスト側の認証情報です。

### GitHub のリポジトリ単位の制限

srt の CLI は、接続先をホスト名の単位で制限します（[anthropics/sandbox-runtime#468](https://github.com/anthropics/sandbox-runtime/issues/468)）。GitHub を許可すると、他人のリポジトリの読み取りも、自分のトークンによる書き込みも通ります。エージェントは、プロンプトインジェクションを仕込んだ他人の issue や README を、承認なしで読み込めます。

strait は、GitHub への要求ごとに、対象のリポジトリと操作を検査します。GraphQL は本文も検査します。承認なしで通すのは `strait.json` に記述したリポジトリの読み取りだけで、他のリポジトリの読み取りと書き込みは、人が承認するまで保留します。

### CONNECT による迂回の遮断

srt 0.0.77 では、SOCKS や TLS 以外の CONNECT を使うと、制限を迂回できます（実測）。strait はこれらの経路を遮断します。

### 端末のサイズの変更の転送

srt の CLI は、Linux で bubblewrap を `--new-session` 付きで起動します。サンドボックス内のプロセスは端末のフォアグラウンドのプロセスグループから外れるので、ウィンドウをリサイズしても SIGWINCH が届かず、Claude Code の表示は起動時のサイズのままになります（[anthropics/sandbox-runtime#642](https://github.com/anthropics/sandbox-runtime/issues/642)）。strait は、自分が受け取った SIGWINCH を、サンドボックス内のプロセスグループに転送します。

### 人による承認

srt の CLI では、許可リストにない通信は拒否されます。strait は、ポリシー外の要求を保留し、人が承認すれば通します。同じ承認の仕組みで、サンドボックス内では動作しないコマンドをホストで実行することもできます（[ホストでのコマンド実行](#ホストでのコマンド実行)）。

## 許可する要求と保留する要求

エージェントが接続できるのは、Anthropic（API と Artifact の内容の取得先）と GitHub だけです。GitHub で承認なしに実行できるのは、`strait.json` に記述したリポジトリの読み取りだけです。

| 要求 | 扱い |
| --- | --- |
| Claude Code が使用する Anthropic の API | 許可 |
| 指定したリポジトリの読み取り（REST、`gh pr view` などの GraphQL、`git fetch`） | 許可 |
| push や issue 作成などの書き込み、他のリポジトリの読み取り、Anthropic の他の API、公開済みの Artifact の内容の取得 | 承認まで保留 |
| 他のホストへの接続、Cookie・URL userinfo・query の access_token による認証 | 拒否 |

サンドボックス内の `GH_TOKEN` などはダミーの値です。許可・承認された要求には、ホスト側で選んだ認証情報を設定します。クライアントが別のトークンを付与した場合も、認証ヘッダーを省略した場合も、上流で使う認証情報は同じです。本文や認証用ではないヘッダーのダミー値は置換しません。ホストに認証情報がなければ匿名の要求だけを受け付け、クライアントが付けた認証情報は拒否します。

上流が認証ヘッダーを反射すると、本物のトークンがサンドボックスへ戻る可能性は残ります。接続先には、そのヘッダーを返却しないサービスを選んでください。レスポンス全体のマスクは行いません。

保留された要求の承認と拒否は、ホストの別のターミナルで `strait review` を起動して行います。承認は 1 件ごとです。

次の機能も利用できます。どちらも既定では無効です。

- サンドボックス内では動作しないコマンド（daemon が必要な `nix build` など）を、1 回ごとの承認でホストで実行する（[ホストでのコマンド実行](#ホストでのコマンド実行)）
- 社内の開発用 API などの接続先を追加する（[接続先の追加](#接続先の追加)）

## 利用前の確認事項

- **動作環境**：確認済みの環境は Linux（x86_64、aarch64）だけです。bubblewrap、socat、ripgrep（`rg`）が必要です。srt がこれらを使用します。
- **承認の頻度**：承認なしで許可する範囲が狭いため、承認の回数は多くなります。例えば push には毎回 2 回の承認が必要です。
- **保留の期限**：保留された要求は、240 秒で拒否されます。期限内に応答がなければ、エージェントには拒否が返却されます。
- **利用できない機能**：
  - WebSocket。公開した Artifact の更新監視（live watch）などは接続できません。
  - `gh` の GraphQL のうち承認なしで許可するのは、gh の主要なコマンド（`pr view`、`issue list`、`repo view` など。`--json` の全フィールドを含む）が送信する query だけです。それ以外は承認待ちになります。`gh pr status` と `gh search` も承認待ちになります。

## インストールと起動

GitHub Release の配布物を展開してインストールします。配布物は Bun を同梱しているので、Bun や Nix は不要です。

```sh
curl -fsSLO https://github.com/Hogeyama/nix-agent-sandbox/releases/download/strait-latest/strait_x86_64-linux.tar.gz
tar -xzf strait_x86_64-linux.tar.gz strait
./strait --extract ~/.local/share/strait
mkdir -p ~/.local/bin
ln -sf ~/.local/share/strait/bin/strait ~/.local/bin/strait
```

aarch64 では、ファイル名の `x86_64` を `aarch64` に替えてください。展開先には、まだ存在しないディレクトリを指定します。`/tmp` の下は避けてください。既定の設定ではサンドボックスから `/tmp` を読めないので、`strait hostexec` と statusline が動作しません。展開せずに `./strait` を実行しても、`--version` 以外は拒否されます。

この URL は常に最新の strait を指します。更新するときは、展開先を削除してから同じ手順を実行してください。インストール済みのバージョンは `strait --version` で、変更点は [CHANGELOG](CHANGELOG.md) で確認できます。特定のバージョンに固定する場合は、`https://github.com/Hogeyama/nix-agent-sandbox/releases/download/strait-v0.1.0/strait-v0.1.0_x86_64-linux.tar.gz` のように、タグを含む URL を使用してください（strait は nas 本体とは別に `strait-v*` タグでリリースしています）。配布物に含まれる第三者のライセンスと、対応するソースの入手方法は [RELEASE-MATERIALS.md](RELEASE-MATERIALS.md) に記載しています。

Nix を使う場合は、このリポジトリのチェックアウトからインストールすることもできます。

```sh
nix profile install .#strait
```

作業ディレクトリに `strait.json` を配置し、`trustedGitHubRepos` に自分のリポジトリを記述します。

```sh
cp contrib/strait/strait.example.json /path/to/workspace/strait.json
```

```json
{
  "trustedGitHubRepos": ["my-org/private-repo"]
}
```

既定の設定では、サンドボックス内から書き込めるのは作業ディレクトリだけです。Claude Code は履歴や設定を保存するので、その保存先を作業ディレクトリ内に作成してください。ホストの `~/.claude` と共有する場合は、[次の節](#claude-code-の履歴や-memory-の共有)を参照してください。

```sh
cd /path/to/workspace
mkdir -p .claude-state
echo '{"hasCompletedOnboarding": true}' > .claude-state/.claude.json
```

トークンを環境変数で指定して起動します。Claude Code のトークンは `claude setup-token` で発行できます。

```sh
GH_TOKEN=$(gh auth token) \
CLAUDE_CODE_OAUTH_TOKEN=... \
CLAUDE_CONFIG_DIR=$PWD/.claude-state \
  strait -- claude --permission-mode auto
```

起動時に、strait は `strait: session k3f9` のようにセッション ID を表示します。Claude Code の statusline の先頭にも `[strait:k3f9]` が表示されます。この ID は、承認時に要求の発生元のターミナルを識別するために使用します。

`strait.json` が存在しない場合、strait は起動しません。設定がないまま、制限のないポリシーで実行されることはありません。

作業ディレクトリの `.claude`（プロジェクトの Claude Code の設定と hook）は、サンドボックス内から変更できません。ホストの Claude Code が次回の起動時に読み込むためです。`.claude` が存在する場合、strait は起動前に `.claude/commands` と `.claude/agents` を作成します。

### Claude Code の履歴や memory の共有

ホストと会話の記録や memory（`~/.claude/projects`）を共有する場合は、`CLAUDE_CONFIG_DIR` を指定せずに起動し、`strait.json` で `~/.claude` 内の書き込み先を追加します。

```json
{
  "trustedGitHubRepos": [
    "my-org/private-repo"
  ],
  "filesystem": {
    "allowWrite": [
      ".",
      "~/.claude.json",
      "~/.claude/projects",
      "~/.claude/backups"
    ],
    "denyRead": [
      "/tmp",
      "~/.ssh",
      "~/.aws",
      "~/.config/gh",
      "~/.claude/.credentials.json",
      "~/.claude/ide"
    ]
  }
}
```

`CLAUDE_CONFIG_DIR` を付けずに起動します。トークンは、上の例と同じく環境変数で渡します。

```sh
GH_TOKEN=$(gh auth token) \
CLAUDE_CODE_OAUTH_TOKEN=... \
  strait -- claude --permission-mode auto
```

`CLAUDE_CODE_OAUTH_TOKEN` を省略すると、Claude Code は `~/.claude/.credentials.json` のトークンを使おうとします。この設定ではこのファイルを読めないので、認証に失敗します。このファイルから読み込んだ値を送っても、上流の認証情報はホストの環境変数から設定されます。ホストに認証情報がなければ、その要求は拒否します。

`~/.claude/projects` をホストと共有しているので、ホストで始めたセッションも、同じディレクトリで `claude --resume <セッション ID>` を実行すれば再開できます。

この例では、`~/.claude` 内の書き込み先を 3 つに限定しています。`~/.claude.json` は Claude Code が頻繁に更新します。`~/.claude/backups` には、Claude Code が `~/.claude.json` を書き換える前の内容を保存します。`~/.claude/projects` には、会話の記録と memory が入ります。

Claude Code は、`~/.claude` 内のほかの場所にも書き込みます。例えば、プロンプトの履歴（`history.jsonl`）や、`/rewind` 用のスナップショット（`file-history`）です。この例ではこれらに書き込めないので、関連する機能が動作しないことがあります。問題が起きた場合は、その書き込み先を `allowWrite` に追加してください。どこに何が書き込まれるかは、Claude Code のドキュメントの [Application data](https://code.claude.com/docs/en/claude-directory#application-data) に記載されています。

ただし、書き込みの許可は、履歴や memory など、エージェントによる変更を容認できるものに限定してください。`settings.json`、`skills`、`plugins`、statusline のスクリプトなど、ホストの Claude Code がサンドボックスの外部で実行するものは、書き込み禁止のままにしてください。`~/.claude.json` には MCP サーバーの起動コマンドも含まれます。ホストの [managed settings](https://code.claude.com/docs/en/settings#settings-files)（`allowManagedMcpServersOnly` など）で、MCP サーバーを制限してください。

この設定例では、`.credentials.json` の読み取りを禁止しています。サンドボックス内の Claude Code はダミーのトークンで動作するので、このファイルを必要としません。`ide/` にも IDE との接続用のトークンがあるので、同様に読み取りを禁止しています。

## 保留した要求の承認

ホストの別のターミナルで作業ディレクトリに移動し、`strait review` を起動します。起動したままにしておくと、保留された要求が一覧に表示されます。

| キー | 操作 |
| --- | --- |
| Enter | カーソル位置の要求（Tab で選択したものすべて）を承認 |
| Ctrl-D | 拒否 |
| Tab | 複数選択 |
| Esc | 終了 |

右側のプレビューには、要求の詳細が表示されます。

- URL と保留の理由
- GraphQL の query
- 要求の発生元のセッション（起動したコマンド、tmux のペイン、端末）

承認や拒否の後も `strait review` は終了しません。

引数を指定しない場合、`strait review` は、現在のディレクトリで起動したセッションの要求だけを表示します。

```sh
strait review k3f9          # 指定したセッションのみ
strait review --all         # すべてのセッション
strait review --json        # 保留中の要求を JSON で出力
strait review approve k3f9-2.x7mq4ndp
strait review deny k3f9-2.x7mq4ndp
```

要求の ID（`k3f9-2.x7mq4ndp`）の末尾は strait の起動ごとに変わります。同じ名前でセッションを再起動しても、再起動前の ID で新しい要求を承認することはありません。

同じディレクトリで複数のセッションを実行する場合は、statusline の `[strait:<ID>]` と一覧の `[<ID>]` を照合してください。`strait --name release -- claude` のように、名前を指定することもできます。要求の保留時には、`notify-send` があればデスクトップ通知も表示されます。`notify-send` が届かない環境（SSH 越しなど）では、`"notify": "terminal"` で端末の通知（OSC 9）に切り替えられます。iTerm2、WezTerm、kitty、Ghostty、Windows Terminal が、ウィンドウが前面にないときに通知を表示します。tmux の中では `set -g allow-passthrough on` が必要です。端末の通知は内容を表示せず、セッション ID だけを示します。

`git push` は、`info/refs?service=git-receive-pack` と `git-receive-pack` の 2 件の要求として保留されます。両方を承認してください。

### ブラウザでの承認

`strait review web` を起動すると、すべてのセッションの保留中の要求を、ホストのブラウザで承認できます。

```sh
strait review web
```

ターミナルに表示されたリンクを、ホストのブラウザで開いてください。左側で要求を選択すると、右側に詳細が表示されます。内容を確認してから、「Approve once」または「Deny」を押してください。要求が自動で選択されることはありません。

- リンクには、この起動に限り有効なトークンが含まれています。サンドボックス内、issue、ログなどに貼り付けないでください。
- ページを再読み込みした場合は、ターミナルのリンクをもう一度開いてください。
- Ctrl-C で終了すると、リンクは無効になります。保留中の要求はそのまま保留されます。

詳細は [SECURITY.md](SECURITY.md#承認経路の保護) を参照してください。

## ホストでのコマンド実行

daemon が必要な `nix build` や、サンドボックスにないツールなど、サンドボックス内では動作しないコマンドがあります。`strait.json` に `"hostExec": true` を記述すると、エージェントはこうしたコマンドのホストでの実行を依頼できます。

```sh
# サンドボックス内で
strait hostexec -- nix build .#sumi
strait hostexec --cwd /path/to/repo --env NIX_CONFIG='...' -- bun run test
```

strait はこの機能の存在をエージェントに通知しません。エージェントに利用させるには、CLAUDE.md などに「サンドボックス内で失敗するコマンドは `strait hostexec -- <コマンド>` で実行する」のように記述してください。

依頼されたコマンドは、ほかの要求と同様に `strait review` に表示されます。プレビューには、引数（1 行に 1 つ）、作業ディレクトリ、環境変数が表示されます。内容を確認してから承認してください。承認は 1 回の実行ごとです。

- 作業ディレクトリは `--cwd` で指定します。省略時は、依頼した時点のディレクトリです。
- 環境変数は、ホストの `PATH` と `HOME` に `--env` で指定したものを追加したものだけです。strait が保持する本物のトークンは継承されません。
- 出力に含まれる本物のトークンは、`[masked by strait]` に置換されます。それ以外の出力は、そのまま返却されます。
- 出力は、コマンドの終了後に一括で返却されます。stdin は使用できません。拒否した場合、エージェントには終了コード 126 が返却されます。
- 実行時間に上限はありません。

承認したコマンドは、ホストで、あなたと同じ権限で実行されます。Claude Code の permission prompt は、この承認の代わりになりません。サンドボックス内のどのプロセスも、prompt を経由せずに実行を依頼できるためです。

## 接続先の追加

### GitHub のリポジトリ

リポジトリは `trustedGitHubRepos` に追加します。追加したリポジトリは、承認なしで読み取れるようになります。`my-org/*` と書くと、`my-org` のすべてのリポジトリが対象になります。owner の部分にワイルドカードは使えません。

gh 2.102 以降の `gh issue view` は、つながった issue（親、子、依存先）のタイトルも取得します。依存先の issue は、他の owner のリポジトリにあってもかまいません。親と子の issue は同じ owner に限られますが、`trustedGitHubRepos` にないリポジトリのこともあります。そのため既定では、このタイトルを含む要求は承認待ちになります。つながる相手が信頼できる範囲に限られる運用（組織の中で閉じている場合など）なら、`"trustLinkedIssues": true` で承認なしにできます。ただし strait は、つながった issue がどのリポジトリにあるかを確かめません。この設定で許可されるのは、どこから来たものでもタイトルだけです。本文やコメントは、設定にかかわらず許可しません。

### その他のホスト

`strait.json` の `hosts` に記述したホストには、承認なしで接続できるようになります。

```json
{
  "hosts": {
    "devapi.example.com": {
      "credential": { "env": "DEVAPI_KEY", "header": "x-api-key" }
    }
  }
}
```

- ホスト名は、完全一致の小文字で記述します。ワイルドカード、ポート、IP アドレスは指定できません。
- `credential` を指定すると、環境変数 `DEVAPI_KEY` の値はサンドボックス内ではダミーになり、このホストへの要求の認証ヘッダーにはホスト側の値を設定します。本文やその他のヘッダーのダミー値は置換しません。`header` には、この値を格納するヘッダーを指定します。`Authorization: Bearer <値>` の形式なら、`"header": "authorization", "scheme": "Bearer"` と指定します。
- このホストへの要求では、エージェントが付けた `Authorization`、`x-api-key`、指定した認証ヘッダーを除去し、指定した認証ヘッダーだけを設定します。`credential` を指定しないホストへの要求では、認証用のヘッダー自体が拒否されます。

追加したホストへの要求は、method や path にかかわらず許可されます。strait が検査するのは認証用のヘッダーだけで、要求がそのサービス内のどこに到達するかは検査しません。そのため、次の 3 条件をすべて満たすサービスに限って追加してください。認証ヘッダーを反射せず、body など別経路の認証で主体を切り替えられないことも必要です。

1. **認証方法が、そのヘッダーだけであること。** 例えば S3 の署名付き URL は、認証情報を query に格納します。S3 を追加すると、エージェントは攻撃者のバケットにあなたのコードをアップロードできます。
2. **認証なしでは書き込めないこと。** 例えば Slack の Incoming Webhook は、URL を知っていれば誰でも投稿できます。`hooks.slack.com` を追加すると、エージェントは攻撃者の Webhook に投稿できます。
3. **あなたのキーでも、外部への公開や転送ができないこと。** 例えば、公開の投稿、メールの送信、任意の URL への Webhook の登録ができる API を持つサービスは、この条件を満たしません。キーがあなたのものでも、データは外部に流出します。GitHub をホスト単位ではなくリポジトリ単位で許可している理由もこれです。あなたのトークンでも、公開の gist は作成できます。

## 設定

`strait.json` に記述できるのは、次のキーだけです。未知のキーがあると、strait は起動しません。

| キー | 内容 | 既定 |
| --- | --- | --- |
| `trustedGitHubRepos` | 承認なしで読み取れる GitHub のリポジトリ（`owner/name`、または owner のすべてのリポジトリを表す `owner/*`） | なし |
| `trustLinkedIssues` | つながった issue（親、子、依存先）のタイトルを、`trustedGitHubRepos` にないリポジトリのものでも承認なしで読み取る | `false` |
| `hostExec` | ホストでのコマンド実行の依頼を許可する | `false` |
| `hosts` | 承認なしで接続できるホストと、その認証情報 | なし |
| `statusLine` | `false` にすると、Claude Code の statusline にセッション ID を表示しない | `true` |
| `notify` | 要求の保留を知らせる方法。`desktop`（`notify-send`）、`terminal`（端末の OSC 9）、`bell`（端末のベル）、`off` | `desktop` |
| `filesystem` | srt と同じ `allowWrite`、`denyWrite`、`denyRead`、`allowRead` | [strait.example.json](strait.example.json) |

`filesystem` の 4 つのキーは、それぞれ既定値を置換します。記述しなかったキーは既定値のままです。例えば `denyRead` を記述するときは、既定値の `/tmp`、`~/.ssh`、`~/.aws`、`~/.config/gh` も含めてください。`/tmp` は、ホストの一時ファイルの読み取りを禁止するための既定値です。srt が使用するソケットだけは、`allowRead` の既定値で許可しています。

既存の srt の設定ファイルは、`filesystem` の節だけを複製すれば使用できます。strait は `network` と `credentials` の節を受け付けません。ネットワークの制限を設定ファイルで緩和できないようにするためです。

`strait.json` と strait 自身のファイルは、サンドボックス内から変更できません。エージェントが次回の起動時の設定を変更することはできません。

起動オプションは次の通りです。

- `--config <path>`：設定ファイル。既定は `./strait.json` です。
- `--name <name>`：セッションの名前。
- `--debug`：srt のデバッグログを出力します。

## 仕組みとレビュー

strait による要求の判定方法、信頼すべきコード、変更後の確認方法については、[SECURITY.md](SECURITY.md) を参照してください。

全体の構成については、[DESIGN.md](DESIGN.md) を参照してください。
