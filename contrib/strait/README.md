# strait

strait は、コマンド（主に Claude Code）を [srt](https://github.com/anthropics/sandbox-runtime)（Anthropic の sandbox-runtime）の中で、固定したネットワークポリシーのもとで動かすツールです。サンドボックス内のプロセスが送る HTTPS の要求は、すべて strait の `filterRequest` で判定します。許可するのは、許可したエンドポイント宛てで、strait が発行したもの以外の認証情報を持たない要求だけです。許可したホスト上のそれ以外のエンドポイントへの要求は、人が `strait review` で承認か拒否をするまで止めておきます。

大事なのは、信頼しなければならないコードの量です。何をサンドボックスの外へ出すか、何をホストで実行するかを決めるのは `src/core/` で、約 2,000 行です（`policy.ts`、`graphql.ts`、`body.ts`、`approval.ts`、`hostexec.ts`、`session.ts`、`config.ts`、`selfcheck.ts`、`main.ts`）。うち約 100 行は GraphQL の許可リストです。信頼の基盤は、このコードと、`strait` の launcher、サブコマンドを振り分ける `src/cli.ts`、srt、srt への小さなパッチ 3 つ、GraphQL の文書を解析する graphql-js です。2 つのパッケージは `package.json` でバージョンを固定しています。

`src/ui/`（約 600 行）は、ポリシーを広げられません。`strait review` はすでに止めてある要求に答えるだけで、statusline とデスクトップ通知は知らせるだけ、`strait hostexec` はもともと信頼しないサンドボックスの中で動きます。`src/core/` は `src/ui/` から何も import しておらず、テストでそれを確かめています。そのため、`src/ui/` の変更にはセキュリティのレビューが要りません。例外は 1 点だけで、`strait review` が表示する内容のエスケープ（後述）です。これが崩れると、ある要求を別の要求に見せかけられます。

## srt にパッチが必要な理由

srt 0.0.77 が TLS を終端して `filterRequest` を呼ぶのは、HTTP プロキシへの要求だけです。ほかに 2 つ、フィルタを通らずに許可したホストへ届く経路があります。[srt-filter-bypass](../../docs/architecture/experiments/srt-filter-bypass/README.md) で両方を実測しました。

- **SOCKS**：プロキシのポートは SOCKS5 も受け付け、SOCKS の接続は中身を見ずに中継します。サンドボックス内のプロセスが `HTTPS_PROXY` を `socks5h://` に変えるだけで、好きなトークンを GitHub へ直接送れます。
- **TLS でない CONNECT**：TLS の ClientHello で始まらない CONNECT の通信は、そのまま中継されます。`github.com:22` や `ssh.github.com:443` への SSH がこの経路で届きました。

[patches/](patches/) で両方を塞いでいます。mux は SOCKS の接続を切り、HTTP プロキシは TLS でない CONNECT の通信を閉じます。`package.json` で srt を `0.0.77` に固定し、`patchedDependencies` でパッチを当てます。

同じパッチファイルに、3 つ目の変更も入っています。これは穴を塞ぐものではなく、[ホストでのコマンド実行](#ホストでコマンドを実行する)に必要なものです。`filterRequest` が `{action: "respond", status, headers, body}` を返すと、srt は要求を上流へ送らず、その応答をクライアントに返します。パッチが当たっていない srt はこの判定を拒否として扱うので、パッチが欠けても安全側に倒れます。`hostExec` を有効にしたときは、起動時にもパッチの有無を確かめます。

strait はコマンドを起動する前に、動いているプロキシを実際に叩いて確かめ（`selfcheck.ts`）、どちらかのパッチが欠けていれば起動しません。そのため、バージョンを上げたときやパッチが当たらなかったときに、穴が黙って開き直ることはなく、はっきり失敗します。パッチを 1 つずつ外すテストで、どちらが欠けても検出できることを確かめています。

## ポリシーが許可するもの

`api.anthropic.com`、`api.github.com`、`github.com` のポリシーはコードに固定しています。`strait.json` でほかのホストを足せます（[ホストの追加](#ホストの追加)）。どのホストにも 443 番だけで接続し、TLS は必ず終端します。どのホストも終端の対象から外せず、設定で外部のプロキシを足すこともできません。

| ホスト | 許可 | 承認待ち |
| --- | --- | --- |
| `api.anthropic.com` | Claude Code のエンドポイント：nas の `presets.anthropic.v1`（messages、bootstrap、telemetry、feature flag）と `GET /api/model_selector/cc` | それ以外すべて。Files API（`/v1/files`）も含む |
| `api.github.com` | `githubRepos` のリポジトリの `/repos/{owner}/{repo}` 以下への `GET`/`HEAD`。そのリポジトリの許可したフィールドだけを読む GraphQL の query（後述） | 他のリポジトリ、`/repositories/{id}`、`/user`、REST の書き込みすべて、GraphQL の mutation と、その他の GraphQL の文書 |
| `github.com` | 同じリポジトリの `git fetch`（`info/refs?service=git-upload-pack`、`git-upload-pack`） | push（`info/refs?service=git-receive-pack`、`git-receive-pack`）、他のリポジトリ、Web ページ |

次の要求は、人に回さずにその場で拒否します。

- 通信の検査に通らない要求：HTTPS でない、443 番でない、URL に認証情報がある、要求先が正規形でない（後述）、許可していないホスト宛て
- strait が発行していない認証情報を持つ要求（[認証情報](#認証情報)を参照）
- strait が本文を読めない GraphQL の要求：256 KiB を超える、UTF-8 でない、JSON でない、content-encoding がある、メンバーが重複している、URL に query string がある

owner と repo の名前は大文字小文字を区別せずに比べます。`%` を含む名前はどれにも一致しません。

srt は要求先をクライアントが送ったとおりに転送しますが、URL の解析では `..`、`%2e`、`\` が解決されます。そのため、解析で要求先が変わる要求は拒否します。strait が判定するパスは、常に GitHub が受け取るパスと同じです。

### ホストの追加

`strait.json` の `hosts` に書いたホストは、443 番へのすべての要求を、method や path を問わず受け付けます。通信の検査は固定のホストと同じです。strait が引き続き管理するのは認証情報です。

```json
{
  "hosts": {
    "devapi.example.com": { "credential": { "env": "DEVAPI_KEY", "header": "x-api-key" } },
    "api.example.org": { "credential": { "env": "ORG_TOKEN", "header": "authorization", "scheme": "Bearer" } },
    "docs.example.com": {}
  }
}
```

- `credential.env` は strait の環境にある変数の名前で、設定されている必要があります。srt は strait 自身の認証情報と同じように、サンドボックスの中ではこの値をダミーにし、このホストへの要求にだけ本物を戻します。
- このホストへの要求に載せてよい認証情報は、その値を `credential.header` に、値そのままか `<scheme> <値>` の形で入れたものだけです。次のものは拒否します。
  - そのヘッダーに入った別の値
  - ヘッダーの重複
  - その認証情報でない `Authorization` や `x-api-key`
  - `Cookie`
  - query の `access_token`

  `credential` のないホストは、これらをどれも受け付けません。
- 名前は完全一致の小文字です。ワイルドカード、ポート、IP アドレスは書けず、固定のホストは上書きできません。strait 自身の変数（`GH_TOKEN` など）は使えず、1 つの変数を 2 つのホストに使うこともできません。

ホストを足すことは、サンドボックスが送るものを誰が受け取ってよいかを決めることです。strait が見るのは認証用のヘッダーだけで、その要求がサービスの中のどこに届くかは見ません。そのため、追加したホストが安全なのは、次の 3 つをすべて満たすときだけです。

1. **strait が確かめるヘッダーが、唯一の認証方法であること。** そうでなければ、サンドボックスは strait が見ていない場所で他人として認証できます。例えば S3 の署名付き URL は、署名を query string に持ちます。そのため、サンドボックスは攻撃者のバケットにあなたのコードをアップロードできます。
2. **認証情報なしでは何も書き込めないこと。** URL そのものが秘密になっている場合、確かめるヘッダーがありません。例えば Slack の Incoming Webhook（`hooks.slack.com/services/...`）です。このホストを許可すると、サンドボックスは攻撃者の Webhook に投稿できます。
3. **自分のキーのままでも、公開や転送ができないこと。** この場合キーはあなたのものですが、それでもデータは外へ出ます。例えば、何かを公開する、メールを送る、任意の URL への Webhook を登録する、といった API です。GitHub にホスト単位の許可ではなくリポジトリ単位のポリシーを書いているのは、このためです。あなたのトークンのままでも、サンドボックスは公開の gist を作れてしまいます。

[脅威モデル](../../docs/architecture/threat-model.md)の `devapi.example.com` は、3 つとも満たす前提です。認証は `x-api-key` だけで重複は拒否し、有効なキーで届くのは自分の開発環境だけで、そこから他人へデータを送る手段はありません。

### GraphQL

strait が本文を読むのは `POST /graphql` だけです。本文は次の条件を満たす必要があります。

- `application/json`（`charset=utf-8` は付けてよい）で、content-encoding がない
- 256 KiB 以下
- メンバーの重複がない、1 つの `{query, variables, operationName}` オブジェクト

URL には query string があってはいけません。そのうえで、文書が次の検査をすべて通る必要があります。

- すべての operation が `query` であること。`operationName` の指定にかかわらず、すべての operation を検査します。
- 選ばれたすべてのフィールドが、`core/graphql.ts` の `GITHUB_FIELDS` にある経路に乗っていること。末端は完全一致で書かれている必要があり、子を持つフィールドは書かれた末端へ続いている必要があります。経路は実際のフィールド名で数えます。alias は外し、fragment は使われる場所で展開し、型条件は無視するので、すべての分岐を検査します。`@skip` や `@include` があっても、フィールドは検査から外れません。
- すべての経路が `repository` から始まり、`repository` のどの出現でも、`owner` と `name` の引数が `githubRepos` の 1 つのリポジトリを指すこと。変数と、宣言された既定値は、operation ごとに解決します。
- strait が解析できる文書であること。構文として正しく、他の directive を使わず、引数・変数・fragment の重複も、未定義や循環する fragment もなく、決まったトークン数・深さ・展開量の範囲に収まる必要があります。

許可リストの経路は、gh 2.46 が `pr view`、`pr list`、`pr checks`、`issue view`、`issue list`、`release view`、`release list`、`repo view` で送るものです。[src/core/testdata/gh_queries.json](src/core/testdata/gh_queries.json) に取り込んであります。末端はすべてスカラーです。どの経路も、他のリポジトリの中身には届きません。届くには `owner { repositories }` や `author { ... on User { pullRequests } }` のようなフィールドが必要で、そういうものは書いていません。

検査に通らない文書は承認待ちになります。その理由には、すべての違反を並べます。query でない operation、許可リストの外にあるフィールド（経路の一番上で 1 回ずつ）、許可していないリポジトリです。省略はしないので、`strait review` に出る理由を見れば、その文書がポリシーの外で取得しようとしているものが全部分かります。

この規則は、nas の [GraphQL のフィールド経路ポリシー](../../docs/superpowers/specs/2026-09-20-graphql-field-path-policy-design.md)を縮めたものです。strait は経路をコードに固定し、nas が owner だけを求めるところで、owner と name の両方を求めます。

### サンドボックスから書けないファイル

`allowWrite` の既定値はワークスペース全体です。設定にかかわらず、strait は次のパスへの書き込みも拒否します。サンドボックス内のプロセスが、次の起動のポリシーを選べないようにするためです。

- 設定ファイル
- strait 自身のディレクトリ：ソース、パッチ、`node_modules` の中のパッチ済み srt
- ワークスペースの `.claude`

Linux の srt が守れるのは、すでに存在するパスだけです。そのため、設定ファイルがないことは空のポリシーではなくエラーにしています。同じ理由で、strait は起動前に空の `.claude/commands` と `.claude/agents` を作ります。srt はこの 2 つを常に守ろうとしますが、読み取り専用の `.claude` の中では bubblewrap がそれを作れないためです。

### 認証情報

strait はホストの環境から次の変数を読みます。srt はサンドボックスの中ではそれぞれの値をランダムなダミー値に置き換え、表のホストへの要求にだけ本物を戻します。`hosts` で足したホストの `credential.env` も同じ扱いです（[ホストの追加](#ホストの追加)）。

| 変数 | ホスト | 受け付ける形 |
| --- | --- | --- |
| `GH_TOKEN` | `api.github.com` | `Authorization: token <s>` または `Bearer <s>` |
| `STRAIT_GIT_AUTH`（`GH_TOKEN` から作る） | `github.com` | `Authorization` の値全体 |
| `CLAUDE_CODE_OAUTH_TOKEN` | `api.anthropic.com` | `Authorization: Bearer <s>` |
| `ANTHROPIC_API_KEY` | `api.anthropic.com` | `x-api-key: <s>` |

HTTPS 越しの git では、GitHub は Basic 認証しか受け付けません。srt はダミー値がそのまま現れる場所でしか置き換えず、base64 の中にあるダミー値は置き換えません。そのため、strait は `Basic …` というヘッダーの値全体を 1 つの認証情報としてマスクします。サンドボックスの中の git は、それを `http.extraHeader` で送ります。

それ以外の認証情報を持つ要求は拒否します。次のものが含まれます。

- 外から持ち込んだ `Authorization`
- 重複した `Authorization`
- 別のホストへ送られた `x-api-key`
- すべての `Cookie`
- query の `access_token`

そのため、サンドボックス内のプログラムが持ち込んだトークンは上流に届かず、別のホストに送られたダミー値も届きません。

### 止めた要求の承認

止めた要求は、プロキシの中で最大 240 秒待ちます。ホストの別のターミナルから、承認か拒否をしてください。

```sh
strait review                  # fzf で開いたまま待つ：Enter で承認、Ctrl-D で拒否、Esc で終了
strait review k3f9             # 同じことを 1 つのセッションについて
strait review --all            # 同じことをすべてのセッションについて
strait review --json [k3f9]    # 待っている要求を JSON で出す
strait review list [k3f9]      # 待っている要求を 1 行ずつ出す
strait review show k3f9-2      # 1 件を全部出す。GraphQL の query はエスケープを外して見せる
strait review approve k3f9-2 ...
strait review deny k3f9-2 ...
```

`strait review` は開いたままになります。承認や拒否をしても閉じずに、一覧を読み込み直します。また 1 秒ごとに、新しく来た要求や消えた要求がないかを確かめ、変わったときに読み込み直します。Tab で複数の要求を選べ、プレビューにはカーソルのある要求が全部出ます。セッション ID も `--all` も付けなければ、今のディレクトリで起動したセッションだけを出します。

`notify-send` があれば、デスクトップ通知も送ります。時間内に誰も答えなければ要求は拒否され、サンドボックスのクライアントが受け取る理由にもそう書かれます。

1 回の承認が効くのは 1 件の要求だけです。`git push` は `info/refs?service=git-receive-pack` と `git-receive-pack` の 2 件の要求を送るので、承認が 2 回要ります。2 件目が待っている間、srt はすでに受け取った pack の部分をメモリに持つことがあります。上流へ送るために本文を複製しているためです。

#### どのセッションの要求か

同じディレクトリで複数の strait のセッションを動かすことはよくあるので、それぞれにセッション ID を付けます。`k3f9` のようなランダムな 4 文字か、`strait --name NAME` で付けた名前です。動いているセッションが使っている名前を、別のセッションが取ることはできません。strait は起動時に ID を表示します。要求の ID はすべて `<セッション>-<連番>` で、一覧にはセッション、tmux のペイン、端末（`tmux %12 pts/3`）が出ます。`show` ではさらに、起動したコマンド、ディレクトリ、起動時刻が出ます。

要求とターミナルをひと目で結び付けられるよう、strait は Claude Code の statusline に ID を出します。起動するコマンドが `claude` のとき、strait は `--settings` を足し、`[strait:k3f9]` を出してから今の statusline を実行する statusline に差し替えます。今の statusline は、`.claude/settings.local.json`、`.claude/settings.json`、ユーザー設定の順に探します。statusline を触らせたくなければ、`strait.json` に `"statusLine": false` と書いてください。サンドボックス内のプロセスは ID を `STRAIT_SESSION` としても受け取るので、エージェントが承認を頼むときにセッションを名指しできます。

動いている strait はそれぞれ、`$XDG_RUNTIME_DIR/strait` の `<セッション>.sock` で待ち受けます。`XDG_RUNTIME_DIR` がなければ、一時ディレクトリの下の `strait-<uid>` を使います。このディレクトリは自分の持ち物で、モードが 0700 である必要があります。サンドボックスからこのソケットに届かない理由は 2 つです。

- Linux では、srt の seccomp フィルタが `AF_UNIX` のソケットを塞ぎます。
- strait はこのディレクトリを `denyRead` に加えます。srt が seccomp の補助プログラムなしで動くときも、これで隠れます。

`strait review` と strait の `XDG_RUNTIME_DIR` が違うと、別のディレクトリを見ることになるので注意してください。

`strait review` が表示するものは、すべてサンドボックスから来ます。URL、理由（GraphQL の引数が入ることがあります）、本文です。そのため、制御文字や書式文字はエスケープして表示し、要求が別の行を偽造したり、ターミナルを書き換えたりできないようにしています。開いたままの review では、fzf が読み込み直しのために localhost のポートで待ち受けます。`FZF_API_KEY` を設定しているので、ほかのローカルプロセスからは操作できません。

### ホストでコマンドを実行する

サンドボックスの中では動かせないコマンドがあります。daemon が必要な `nix build` や、サンドボックスにないツールです。`strait.json` に `"hostExec": true` と書くと、サンドボックス内のプロセスが、そうしたコマンドをホストで実行するよう頼めます。strait は自分をサンドボックスの `PATH` に入れるので、サンドボックスからは `strait hostexec` で呼べます。

```sh
# サンドボックスの中で
strait hostexec --env NIX_CONFIG='...' -- nix build .#sumi
strait hostexec --cwd /path/to/repo --env GH_HOST -- gh release view
```

- `--cwd DIR` で作業ディレクトリを指定します。省略すると今のディレクトリです。サンドボックスの中のパスは、ホストと同じです。
- `--env NAME=VALUE` で変数を設定し、`--env NAME` でサンドボックスの中の値をそのまま渡します。コマンドが受け取る環境は、strait の環境の `PATH` と `HOME` に、ここで指定した変数を足したものだけです。strait の環境には本物のトークンがあるので、それ以外は渡しません。
- どの実行も、ほかの要求と同じように承認待ちになります。`strait review` は、引数を 1 つずつ別の行に、作業ディレクトリと変数も 1 つずつ出します。1 回の承認が効くのは、その 1 回の実行だけです。自動で許可する規則はありません。
- stdout と stderr はコマンドが終わってからまとめて返り、終了コードもコマンドのものがそのまま返ります。stdin はなく、出力の逐次表示もしません。拒否された要求は 126 で終わります。クライアントがいなくなると、コマンドは止めます。
- strait が持っている本物の認証情報は、出力の中で `[masked by strait]` に置き換えます。そのため、承認した `gh auth token` から本物のトークンがサンドボックスに渡ることはありません。それ以外の出力は伏せずに返ります。コマンドがサンドボックスから読めるファイルに書いたものも同じです。

この要求は `POST https://hostexec.strait.invalid/run` として srt のプロキシを通るので、外への出口は `filterRequest` の 1 か所のままです。このホスト名は存在しません。許可リストに入るのは `hostExec` が有効なときだけで、srt はこの名前を名前解決も接続もしません。strait が `respond` のパッチで答えます。Linux の srt は Unix ソケットを塞ぐので、nas のようにソケットで hostexec をつなぐことはできません。srt の `mitmProxy` の設定も、TLS の終端とは一緒に使えません。

実行時間と出力の大きさには上限がありません。上限が 240 秒なのは承認を待つ時間だけで、承認後のコマンドはそれを越えても動き続けます。

## 使い方

```sh
nix profile install .#strait    # または nix build .#strait して result/bin を使う
cp contrib/strait/strait.example.json /path/to/workspace/strait.json   # githubRepos を書き換える

cd /path/to/workspace
GH_TOKEN=$(gh auth token) \
CLAUDE_CODE_OAUTH_TOKEN=... \
  strait -- claude --permission-mode auto
```

チェックアウトの `contrib/strait/strait` ではなく、パッケージにした strait を使ってください。strait は、自分のディレクトリを常にサンドボックスから読み取り専用にします。そのコードが次の起動でホストで動くためです。ワークスペースの中のチェックアウトから起動すると、そのディレクトリは編集中のソースそのものなので、サンドボックスから触れなくなります。パッケージは nix store にあり、もともと読み取り専用なので、チェックアウトは書き込めるまま残ります。パッケージのビルドで srt のパッチを当て、3 つの変更のどれかが欠けていればビルドが失敗します。

strait 自体を開発するときは、`cd contrib/strait && bun install` でチェックアウトを整えれば、テストや `contrib/strait/strait` の直接の起動に使えます。依存を変えたら、`contrib/strait` で `bun2nix -o bun.nix` を実行して、パッケージに反映してください。

strait は必ず launcher（`strait`、チェックアウトでは `contrib/strait/strait`）から起動し、`bun src/cli.ts` では起動しないでください。そうしないと、bun は作業ディレクトリの `bunfig.toml` と `.env` を読みます。作業ディレクトリはサンドボックスが書き込めるワークスペースなので、そこに仕込まれた `preload` が、次の起動でホスト上のサンドボックスの外で動いてしまいます。launcher は `--config=<strait>/bunfig.toml --no-env-file` を渡すので、どちらのファイルも読まれません。

オプションは次の通りです。コマンドは `--` のあとか、オプションでない最初の引数から始まります。

- `--config <path>`：既定は `./strait.json`。このファイルは存在する必要があります。
- `--name NAME`：セッションの名前。
- `--debug`：srt のデバッグログを出す。

Claude Code については、[srt-trial](../../docs/architecture/experiments/srt-trial/README.md) で分かった起動時の注意が今も当てはまります。

- `CLAUDE_CONFIG_DIR` を、ワークスペースの中の状態用ディレクトリに向ける。
- `.claude.json` を `"hasCompletedOnboarding": true` で先に作っておく。
- `denyWrite` のパスは、起動前にすべて作っておく。Linux の srt は、すでに存在するパスしか守れません。

これはホスト上で Claude Code 2.1.284 と `claude -p … --permission-mode auto` を使って確かめました。コマンドは動き、フィルタは何も拒否しませんでした。拒否されたのは `http-intake.logs.us5.datadoghq.com` への要求だけで、これは許可していないホストです。

### ホストの `~/.claude` を使う

履歴、memory、projects をホストの Claude Code と共有するには、`CLAUDE_CONFIG_DIR` を設定しないでください。そのうえで `~/.claude` と `~/.claude.json` への書き込みを許可し、ホストに影響する部分を拒否します。

```json
{
  "filesystem": {
    "allowWrite": [".", "~/.claude", "~/.claude.json"],
    "denyWrite": [".claude", "~/.claude/settings.json", "~/.claude/skills", "~/.claude/plugins"],
    "denyRead": ["/tmp", "~/.ssh", "~/.aws", "~/.config/gh", "~/.claude/.credentials.json"],
    "allowRead": ["/tmp/claude-http-*.sock"]
  }
}
```

- `.credentials.json` には本物の OAuth トークンがあります。サンドボックスの中の Claude Code は `CLAUDE_CODE_OAUTH_TOKEN` のダミー値で動くので、これを読む必要はありません。
- `settings.json`、`skills`、`plugins` には、ホストの Claude Code がサンドボックスの外で動かす hook やスクリプトがあります。`CLAUDE.md`、`hooks`、`commands`、`agents`、statusline のスクリプトなど、ホストにある同じ種類のパスはすべて足してください。srt はまだ存在しないパスを守れません。
- `~/.claude.json` は Claude Code が頻繁に書くので、書き込めるままにしておく必要があります。ここには MCP サーバーの起動コマンドもあり、ホストの Claude Code がそれを起動します。ホストの managed settings（例えば `allowManagedMcpServersOnly`）で MCP サーバーを制限してください。
- 履歴、memory、projects は書き込めて、共有されます。エージェントがそこに書いたものは、以後のセッションに引き継がれます。

これはホスト上で Claude Code 2.1.284 を使って確かめました。サンドボックスの中からは `.credentials.json` が読めず、`settings.json` と `skills` は読み取り専用で、履歴と `~/.claude.json` は書き込めました。`claude -p` は動きました。

### 設定

`strait.json` が受け付けるキーは次の 5 つだけで、知らないキーは拒否します。

- `githubRepos`：`owner/name` の文字列。
- `hostExec`：`true` にすると、サンドボックスがホストでのコマンド実行を頼めるようになります（前述）。既定は無効です。
- `statusLine`：`false` にすると、Claude Code の statusline にセッション ID を出しません。既定は有効です。
- `hosts`：固定のホストのほかに許可するホストと、それぞれが受け付ける認証情報（[ホストの追加](#ホストの追加)）。
- `filesystem`：`allowWrite`、`denyWrite`、`denyRead`、`allowRead`。srt の `filesystem` の節と同じ項目で、既定値は [strait.example.json](strait.example.json) にあります。

**既存の `srt-settings.json` はそのままでは使えません。** その `filesystem` の節を `strait.json` に写してください。ほかの節は、わざと拒否しています。

- `network`：TLS の終端とフィルタはコードに固定しています。ホストを足すには、代わりに `hosts` を使ってください。
- `credentials`：strait は認証情報を、上の環境変数からしか受け取りません。ファイルのマスク（`credentials.files`）には対応していません。`.env` のようにエージェントに読ませたくないファイルは、代わりに `denyRead` に入れてください。

## 制限

- **GraphQL で通るのは、gh が 1 回目に送ったものだけです。** 取り込んだ query は、gh 2.46 の各コマンドの最初の要求だけです。gh のバージョンが違う、フィールドを足すフラグを付ける、同じコマンドの 2 回目以降の要求、のどれかで許可リストにない経路を選ぶことがあり、その要求は承認待ちになります。`gh api repos/...` はどちらでも動きます。
- **WebSocket は使えません。** srt は、TLS を終端したコネクションでの upgrade 要求を、`filterRequest` を呼ぶ前に拒否します（`tls-terminate-proxy.js`、コメントは "out of scope for now"）。そのため WebSocket は、ポリシーにも承認にも届かずに失敗します。例えば、publish した Artifact の Claude Code による live watch は接続できません。
- **承認は 1 件ずつです。** 「このセッションの間は許可する」という範囲はありません。`/graphql` のような 1 つのパスが、あらゆる種類の要求を含むためです。ポリシーの外の要求をたくさん送るコマンドは、1 件ごとに承認が要ります。
- **長く止めたときの動きは、実際には試していません。** `probe.sh` は 1 秒以内に承認や拒否をします。240 秒経つ前に、クライアントや srt のサーバーが諦めてしまわないかは確かめていません。Node の `requestTimeout` の既定値が 300 秒なので、上限をそれより短くしています。
- **strait に含まないもの：** ファイル内容のマスク（maskfs）、出力のマスク（sumi）、監査ログなど、nas の機能。
- **試したのは Linux だけです。** macOS では srt の別の実装が動き、パッチもそこでは確かめていません。
- **原因の分からない失敗が 1 つあります。** 4 回の起動で、サンドボックスの中から `~/.local/bin` のコマンド（`gh` や `claude`）が見つかりませんでした。直後に起動し直すと再現しませんでした。連続で起動しても、トークンの有無を変えても、コマンドを直接起動しても `bash -c` 経由で起動しても同じでした。原因は分かっていません。

## テスト

```sh
bun run test:strait-unit        # ポリシー、GraphQL、承認、hostexec、設定。リポジトリのルートで実行し、srt は不要
node_modules/.bin/tsc -p contrib/strait/tsconfig.json   # 先に contrib/strait で bun install が必要
GH_TOKEN=$(gh auth token) contrib/strait/tests/probe.sh [owner/repo]
```

`tests/probe.sh` は、ネットワーク、bubblewrap、socat のある Linux ホストで動かす実地の検査です。許可されるべき要求（発行したトークンを付けた `curl`、`gh api`、`git ls-remote`、Claude Code の messages エンドポイントへの要求）と並べて、次の迂回を試します。

- 外から持ち込んだトークン、重複したトークン
- 他のリポジトリ
- REST の書き込み、GraphQL の mutation、push の開始
- Files API と、許可していないホスト
- SOCKS、CONNECT 越しの SSH、自分で TLS を張るクライアント
- 設定ファイル、strait のソース、パッチ済みの srt への書き込み
- ワークスペースに仕込んだ `bunfig.toml` の preload

追加したホストは httpbin.org で確かめます。受け取ったヘッダーをそのまま返すので、次の両方が見えます。

- 発行したキーは本物の値になって届く
- 外から持ち込んだキー、キーのヘッダーの重複、別の認証ヘッダーは拒否される

承認と hostexec も確かめます。

- 承認した、他のリポジトリへの REST の読み取りと、許可リストにない GraphQL の query は通る
- サンドボックスからは止めた要求が見えない
- 承認したホストのコマンドは、サンドボックスの外で、指定した環境だけを受け取って動き、出力はマスクされる
- 拒否したコマンドは 126 で終わる

承認待ちになる迂回の試みは、403 を期待しています。`probe.sh` は裏で止めた要求を順に見て、目印（`strait-probe-approve`）の付いたものを承認し、`strait-probe-hold` の付いたものは待たせたまま、それ以外は拒否します。実行中は何も承認しないでください。
