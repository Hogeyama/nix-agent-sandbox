# strait

strait は、Claude Code などのコーディングエージェントに、srt と同様の強制的な制限を課すツールです。サンドボックスには Anthropic の [srt](https://github.com/anthropics/sandbox-runtime) を使用し、srt の CLI の不満点を解消しています。

srt の CLI には、次の不満点があります。

- 接続先をホスト名単位でしか制限できません。GitHub を許可すると、他人の repo への書き込みや、攻撃者のトークンによる通信も許可されます。
- SOCKS や TLS 以外の CONNECT を使用すると、制限を迂回できます（srt 0.0.77 で実測）。
- 許可リストにない通信は拒否するしかなく、人が確認して許可する手段がありません。
- サンドボックス内で動作しないコマンドを、ホストで実行する手段がありません。

strait は、これらを次のように解消します。

- 要求ごとに、repo、操作、GraphQL の本文、認証情報を検査します。
- srt にパッチを適用し、迂回経路を遮断します。
- ポリシー外の要求を保留し、人の承認によって許可します。
- 承認を条件に、ホストでコマンドを実行します。

これらの制限は、エージェントの判断には依存しません。サンドボックスの外部で動作する strait のプロキシと、srt のファイルシステムの設定が適用します。

## 許可する要求と保留する要求

エージェントが接続できるのは、Anthropic（API と Artifact の内容の取得先）と GitHub だけです。GitHub で承認なしに実行できるのは、`strait.json` に記述した repo の読み取りだけです。

| 要求 | 扱い |
| --- | --- |
| Claude Code が使用する Anthropic の API | 許可 |
| 指定した repo の読み取り（REST、`gh pr view` などの GraphQL、`git fetch`） | 許可 |
| push や issue 作成などの書き込み、他の repo の読み取り、Anthropic の他の API、公開済みの Artifact の内容の取得 | 承認まで保留 |
| 他のホストへの接続、strait が発行していないトークンを付与した要求 | 拒否 |

エージェントには本物のトークンを提供しません。サンドボックス内の `GH_TOKEN` などはダミーの値で、決まった送信先への要求でだけ本物に置換されます。そのため、エージェントが別のトークンを付与した要求は拒否されます。エージェントが本物のトークンを取得することもできません。

保留された要求の承認と拒否は、ホストの別のターミナルで `strait review` を起動して行います。承認は 1 件ごとです。

次の機能も利用できます。どちらも既定では無効です。

- サンドボックス内では動作しないコマンド（daemon が必要な `nix build` など）を、1 回ごとの承認でホストで実行する（[ホストでのコマンド実行](#ホストでのコマンド実行)）
- 社内の開発用 API などの接続先を追加する（[接続先の追加](#接続先の追加)）

## 利用前の確認事項

- **動作環境**：確認済みの環境は Linux だけです。bubblewrap と socat が必要です。インストールには Nix を使用します。
- **承認の頻度**：承認なしで許可する範囲が狭いため、承認の回数は多くなります。例えば push には毎回 2 回の承認が必要です。
- **保留の期限**：保留された要求は、240 秒で拒否されます。期限内に応答がなければ、エージェントには拒否が返却されます。
- **利用できない機能**：
  - WebSocket。公開した Artifact の更新監視（live watch）などは接続できません。
  - `gh` の GraphQL のうち承認なしで許可するのは、gh の主要なコマンド（`pr view`、`issue list` など）が送信する query だけです。それ以外は承認待ちになります。

## インストールと起動

このリポジトリのチェックアウトからインストールします。

```sh
nix profile install .#strait
```

作業ディレクトリに `strait.json` を配置し、`githubRepos` に自分の repo を記述します。

```sh
cp contrib/strait/strait.example.json /path/to/workspace/strait.json
```

```json
{
  "githubRepos": ["my-org/private-repo"]
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

ホストと履歴・memory・projects を共有する場合は、`CLAUDE_CONFIG_DIR` を指定せずに起動し、`strait.json` で `~/.claude` 内の書き込み先を追加します。

```json
{
  "githubRepos": ["my-org/private-repo"],
  "filesystem": {
    "allowWrite": [
      ".", "~/.claude.json",
      "~/.claude/projects", "~/.claude/history.jsonl", "~/.claude/file-history",
      "~/.claude/plans", "~/.claude/paste-cache", "~/.claude/todos", "~/.claude/debug",
      "~/.claude/telemetry", "~/.claude/usage-data", "~/.claude/stats-cache.json",
      "~/.claude/backups", "~/.claude/feedback"
    ],
    "denyRead": [
      "/tmp", "~/.ssh", "~/.aws", "~/.config/gh",
      "~/.claude/.credentials.json", "~/.claude/ide"
    ]
  }
}
```

この設定で Claude Code 2.1.285 が動作することを確認済みです（2026-10-01）。

書き込みの許可は、履歴や memory など、エージェントによる変更を容認できるものに限定してください。`settings.json`、`skills`、`plugins`、statusline のスクリプトなど、ホストの Claude Code がサンドボックスの外部で実行するものは、書き込み禁止のままにしてください。`~/.claude.json` は Claude Code が頻繁に更新するので、書き込みの許可が必要です。ただし、このファイルには MCP サーバーの起動コマンドも含まれます。ホストの [managed settings](https://code.claude.com/docs/en/settings#settings-files)（`allowManagedMcpServersOnly` など）で、MCP サーバーを制限してください。

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

同じディレクトリで複数のセッションを実行する場合は、statusline の `[strait:<ID>]` と一覧の `[<ID>]` を照合してください。`strait --name release -- claude` のように、名前を指定することもできます。`notify-send` があれば、要求の保留時にデスクトップ通知も表示されます。

`git push` は、`info/refs?service=git-receive-pack` と `git-receive-pack` の 2 件の要求として保留されます。両方を承認してください。

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

### GitHub の repo

repo は `githubRepos` に追加します。追加した repo は、承認なしで読み取れるようになります。

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
- `credential` を指定すると、環境変数 `DEVAPI_KEY` の値はサンドボックス内ではダミーになり、このホストへの要求でだけ本物に置換されます。`header` には、この値を格納するヘッダーを指定します。`Authorization: Bearer <値>` の形式なら、`"header": "authorization", "scheme": "Bearer"` と指定します。
- このホストへの要求のうち、エージェントが別のキーを付与したものは拒否されます。`credential` を指定しないホストへの要求では、認証用のヘッダー自体が拒否されます。

追加したホストへの要求は、method や path にかかわらず許可されます。strait が検査するのは認証用のヘッダーだけで、要求がそのサービス内のどこに到達するかは検査しません。そのため、次の 3 条件をすべて満たすサービスに限って追加してください。

1. **認証方法が、そのヘッダーだけであること。** 例えば S3 の署名付き URL は、認証情報を query に格納します。S3 を追加すると、エージェントは攻撃者のバケットにあなたのコードをアップロードできます。
2. **認証なしでは書き込めないこと。** 例えば Slack の Incoming Webhook は、URL を知っていれば誰でも投稿できます。`hooks.slack.com` を追加すると、エージェントは攻撃者の Webhook に投稿できます。
3. **あなたのキーでも、外部への公開や転送ができないこと。** 例えば、公開の投稿、メールの送信、任意の URL への Webhook の登録ができる API を持つサービスは、この条件を満たしません。キーがあなたのものでも、データは外部に流出します。GitHub をホスト単位ではなく repo 単位で許可している理由もこれです。あなたのトークンでも、公開の gist は作成できます。

## 設定

`strait.json` に記述できるのは、次のキーだけです。未知のキーがあると、strait は起動しません。

| キー | 内容 | 既定 |
| --- | --- | --- |
| `githubRepos` | 承認なしで読み取れる GitHub の repo（`owner/name`） | なし |
| `hostExec` | ホストでのコマンド実行の依頼を許可する | `false` |
| `hosts` | 承認なしで接続できるホストと、その認証情報 | なし |
| `statusLine` | `false` にすると、Claude Code の statusline にセッション ID を表示しない | `true` |
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
