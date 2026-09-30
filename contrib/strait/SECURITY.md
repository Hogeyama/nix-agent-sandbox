# strait のセキュリティ設計

strait のコードをレビュー・変更する人のための文書です。保護の対象、信頼すべきコード、変更後の確認方法を記載します。使用方法は [README](README.md) を参照してください。

## 保護の対象

[脅威モデル](../../docs/architecture/threat-model.md)の被害のうち、strait が阻止するのは次の 4 つです。エージェントやサンドボックス内のプログラムが、制限の回避を試みることを前提とします。

| 被害 | strait の対策 |
| --- | --- |
| A1a：許可していない送信先への流出 | 接続先を、固定のホスト、Artifact の内容の取得先、`hosts` に記述したホストの 443 番に限定する |
| A1b：許可したサービス内での、共有を許可していない相手への流出 | GitHub では repo と操作を検査し、書き込みと他の repo への要求を保留する。strait が発行していない認証情報を拒否する |
| B2a：ホストのファイルや実行設定の改変 | srt で書き込み先を制限し、strait 自身と設定ファイルへの書き込みも禁止する |
| P1：未信頼の情報源の無人取り込み | GitHub から承認なしに取得できる情報を、指定した repo の特定の経路に限定する |

`hosts` に記述したホストについては、strait は A1b を判定しません。検査するのは認証用のヘッダーだけです。そのホストが README の 3 条件を満たすかどうかは、設定者が判断します。

## 信頼すべきコード

判定に関与するのは `src/core/` だけです。約 2,000 行で、そのうち約 100 行は GraphQL の許可リスト（データ）です。

| ファイル | 役割 |
| --- | --- |
| `main.ts` | srt を設定し、コマンドをサンドボックスで起動する |
| `policy.ts` | 要求ごとに、許可・保留・拒否を決定する |
| `graphql.ts` | GraphQL の文書を解析し、経路を検査する |
| `body.ts` | 判定に使用する本文を、上限付きで読み込む |
| `approval.ts` | 保留中の要求を保持し、承認用のソケットで待機する |
| `hostexec.ts` | ホストでのコマンド実行の要求を解析・実行し、出力をマスクする |
| `session.ts` | セッション ID と承認用ソケットを確保する |
| `config.ts` | `strait.json` を検証する |
| `selfcheck.ts` | 起動時に、srt のパッチの有効性を検証する |

このほかに信頼の対象となるのは、`strait` の launcher、サブコマンドを振り分ける `src/cli.ts`、srt、srt へのパッチ、graphql-js です。srt と graphql-js のバージョンは `package.json` で固定しています。

`src/ui/`（約 600 行）は判定に関与しません。

- `review.ts`（`strait review`）：保留中の要求に、承認または拒否を返却するだけです。
- `statusline.ts`、`notify.ts`：通知するだけです。
- `hostexec_client.ts`（`strait hostexec`）：サンドボックス内で実行されるので、もともと信頼の対象外です。

`src/core/` は `src/ui/` を import しません。`src/boundary_test.ts` がこれを検証します。`main.ts` と UI の接点は、起動するコマンドを置換するフックと、要求の保留を通知するフックの 2 つだけです。どちらも判定を変更できません。そのため、`src/ui/` の変更にセキュリティのレビューは不要です。

例外は `strait review` の表示です。表示する URL、保留の理由、本文は、いずれもサンドボックスから送信されたものです。これらに改行や端末の制御文字が含まれていれば、サンドボックス内のプログラムは、ある要求を別の要求に偽装して承認させることができます。`review.ts` は制御文字と書式文字（Unicode の Cc と Cf）をエスケープして表示します。この処理を変更する場合はレビューしてください。

## srt へのパッチ

srt 0.0.77 は、HTTP プロキシへの要求についてだけ、TLS を終端して `filterRequest` を呼び出します。次の 2 つの経路では、要求が判定を経ずに許可済みのホストへ到達します（[srt-filter-bypass](../../docs/architecture/experiments/srt-filter-bypass/README.md) で実測）。

- **SOCKS**：プロキシのポートは SOCKS5 も受け付け、内容を検査せずに中継します。サンドボックス内のプログラムは、`HTTPS_PROXY` を `socks5h://` に変更するだけで、任意のトークンを GitHub に送信できます。
- **TLS 以外の CONNECT**：TLS で開始しない CONNECT の通信は、そのまま中継されます。`github.com:22` や `ssh.github.com:443` への SSH が、この経路で到達しました。

[patches/](patches/) のパッチにより、mux は SOCKS の接続を切断し、HTTP プロキシは TLS 以外の CONNECT を切断します。

同じパッチには、`filterRequest` が `{action: "respond", ...}` を返却した場合に、srt が上流に送信せずにその応答をクライアントに返却する変更も含まれます。この変更は、ホストでのコマンド実行に使用します。パッチがない srt はこの判定を拒否として扱うので、安全側に動作します。

パッチの有効性は、次の 3 段階で検証します。

1. **ビルド時**：`nix build .#strait` は、パッチ済みの srt に 3 つの変更（SOCKS の切断、TLS 以外の CONNECT の切断、respond）の目印があるかを検証し、欠落していれば失敗します。
2. **起動時**：`selfcheck.ts` が、稼働中のプロキシに SOCKS と TLS 以外の CONNECT を実際に送信します。どちらかが中継された場合、strait は起動しません。パッチを 1 つずつ除去し、いずれの欠落も検出できることを確認済みです。
3. **起動時（hostExec）**：`hostExec` が有効な場合は、respond の変更の有無も検証します。

srt のバージョンを更新する場合は、パッチを再適用し、この 3 段階の検証がすべて成功することを確認してください。

## 判定の要点

許可リストにないホストへの接続は、`filterRequest` に到達する前に、srt が CONNECT の段階で拒否します。許可リストは、固定の 3 ホスト、Artifact の内容の取得先（`*.frame.claudeusercontent.com`）、`hosts` に記述したホスト、`hostExec` が有効な場合の `hostexec.strait.invalid` です。

許可リストのホストへの要求を、`policy.ts` は次の順序で検査します。

1. **通信の検査**：HTTPS であること、443 番であること、URL に認証情報がないこと。
2. **要求先の正規形**：srt は、クライアントが送信した要求先をそのまま上流に転送します。一方、strait が判定に使用する URL の解析では、`..`、`%2e`、`\` が解決されます。解析によって要求先が変化する要求は拒否します。これにより、strait が判定するパスと、上流が受信するパスが常に一致します。
3. **認証情報**：`Authorization`、`x-api-key`、`Cookie`、query の `access_token` を検査します。strait が発行した値を、決まったホストに決まった形式で送信する場合だけ許可します。
4. **ホストごとのポリシー**：Anthropic の API では固定のエンドポイントだけ、GitHub の API では指定した repo への読み取りの操作だけ、git では fetch だけを許可します。`hosts` のホストへの要求は、すべて許可します。Artifact の内容の取得先への要求は、すべて保留します。取得先のホストは Artifact ごとに異なるので、srt の許可リストにはワイルドカードで登録し、`policy.ts` でサブドメインを 1 階層に限定します。

1〜3 の検査に合格し、4 のポリシーに該当しない要求は、保留されて人の承認を待ちます。1〜3 の検査で不合格となった要求は、人に回さずに拒否されます。外部から持ち込まれたトークンが、人の承認によって上流に到達することはありません。

### 認証情報

サンドボックス内の `GH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` などは、srt が生成したダミーの値です。srt は、決まったホストへの要求でだけ、ダミーの値を本物に置換します。strait はさらに、要求の認証情報がそのダミーの値と一致するかを検証します。そのため、サンドボックス内のプログラムが独自に用意したトークン（攻撃者のアカウントのもの）を付与した要求は、上流に到達しません。

HTTPS 越しの git は Basic 認証しか使用できず、srt は base64 で符号化された値の中のダミーを置換しません。そこで strait は、`GH_TOKEN` から `Basic …` の値全体を生成し、その値全体を 1 つの認証情報として srt に登録します。サンドボックス内の git は、この値を `http.extraHeader` で送信します。

同名のヘッダーが 2 つある場合、node:http の扱いはヘッダーによって異なります。node:http は、`Authorization` については 1 つ目だけを保持し、`x-api-key` などについては `, ` で連結します。srt は判定にも上流への送信にも同じヘッダーを使用します。そのため、連結された値は一致せずに拒否され、破棄された 2 つ目の `Authorization` は上流に到達しません。`probe.sh` で両方を実地に確認しています。

### GraphQL

strait が本文を読み込むのは、`POST /graphql` だけです。本文は、256 KiB 以下の UTF-8 の JSON で、メンバーが重複しない 1 つの `{query, variables, operationName}` オブジェクトである必要があります。

strait は、次の条件をすべて満たす文書だけを許可します。

- operation がすべて `query` である。
- 選択されたフィールドがすべて、`graphql.ts` の `GITHUB_FIELDS` の経路上にある。alias を除去し、fragment を使用箇所で展開し、型条件を無視して、すべての分岐を検査します。`@skip` や `@include` があっても検査の対象です。
- すべての `repository` について、`owner` と `name` が `githubRepos` のいずれか 1 つを指す。
- 解析可能である。未知の directive、引数・変数・fragment の重複、未定義や循環する fragment、トークン数・深さ・展開量の上限の超過がある文書は、解析不能として許可しません。

`GITHUB_FIELDS` は、gh 2.46 の主要なコマンドが送信する query から作成しました（`src/core/testdata/gh_queries.json`）。末端はすべてスカラーで、他の repo の内容に到達する経路（`owner { repositories }` など）は含みません。許可リストの末端と、収録した query の末端が完全に一致することをテストで検証しています。経路を追加する場合は、その query を testdata に追加してください。

条件を満たさない文書は保留され、理由にはすべての違反が列挙されます。この規則は nas の[フィールド経路ポリシー](../../docs/superpowers/specs/2026-09-20-graphql-field-path-policy-design.md)を簡略化したものです。nas と異なり、owner と name の両方を要求します。

## 承認経路の保護

承認用のソケットにサンドボックスから到達できれば、エージェントは自身の要求を承認できてしまいます。strait はソケットを `$XDG_RUNTIME_DIR/strait`（未設定の場合は一時ディレクトリの `strait-<uid>`）に配置し、次の 3 つの方法で保護します。

- 起動時に、ディレクトリの所有者が自分であり、モードが 0700 であることを検証します。
- Linux では、srt の seccomp フィルタが、サンドボックス内での `AF_UNIX` のソケットを遮断します。
- strait はこのディレクトリを `denyRead` に追加します。srt が seccomp の補助プログラムなしで動作する場合でも、サンドボックス内からはこのディレクトリが空の tmpfs に見えます。そこにソケットを作成しても、ホスト側には出現しません。

常駐する `strait review` は、再読み込みのために fzf を localhost のポートで待機させます。fzf はこのポート経由で `execute` も受け付けるので、`strait review` は `FZF_API_KEY` を設定して、他のプロセスからの操作を防止しています。サンドボックスは別のネットワーク名前空間にあるので、このポートにはそもそも到達できません。

## ホストでのコマンド実行の経路

Linux の srt は Unix ソケットを遮断するので、nas のようにソケット経由でホストのブローカーに接続することはできません。srt の `mitmProxy` の設定も、TLS の終端と併用できません（`sandbox-manager.js` が拒否します）。

そこで `strait hostexec` は、実行の要求を `POST https://hostexec.strait.invalid/run` として srt のプロキシに送信します。このホスト名は実在しません。strait がこのホスト名を許可リストに登録するのは、`hostExec` が有効な場合だけです。strait はこの要求を保留し、承認後にホストで実行し、respond のパッチで結果を返却します。srt はこのホスト名の名前解決も接続も行いません。外部への出口は、`filterRequest` の 1 か所のままです。

実行するコマンドの環境変数は、ホストの `PATH` と `HOME` に、要求で宣言された変数を追加したものだけです。strait 自身の環境変数は、本物のトークンを含むため継承しません。出力に含まれる本物の認証情報は、マスクしてから返却します。

## サンドボックスから変更できないファイル

strait の設定ファイルと strait 自身のファイルは、次回の起動時にホストで使用されます。サンドボックスから変更できると、エージェントが次回のポリシーを選択できてしまいます。そのため、設定にかかわらず、次のパスを `denyWrite` に追加します。

- 設定ファイル
- strait のディレクトリ全体（`STRAIT_ROOT`）：launcher、ソース、パッチ、パッチ済みの srt
- 作業ディレクトリの `.claude`

`STRAIT_ROOT` がディレクトリ全体を指すことは、`src/boundary_test.ts` で固定しています。ファイルの移動によって、保護の範囲が縮小しないようにするためです。

Linux の srt が保護できるのは、既存のパスだけです。設定ファイルがない場合に、空のポリシーで起動せずエラーとするのはこのためです。同じ理由で、strait は起動前に空の `.claude/commands` と `.claude/agents` を作成します。srt はこの 2 つを常に保護しようとしますが、読み取り専用の `.claude` の中には、bubblewrap がマウントポイントを作成できないためです。

strait の起動には、必ず launcher を使用してください。`bun src/cli.ts` で起動すると、bun が作業ディレクトリの `bunfig.toml` と `.env` を読み込みます。作業ディレクトリはサンドボックスから書き込み可能なので、そこに仕込まれた `preload` が、次回の起動時にホストで実行されてしまいます。launcher は `--config=<strait>/bunfig.toml --no-env-file` を指定し、どちらも読み込ませません。

## 変更後の確認

```sh
bun run test:strait-unit                                # リポジトリのルートで実行。srt は不要
node_modules/.bin/tsc -p contrib/strait/tsconfig.json   # 事前に contrib/strait で bun install
nix build .#strait                                      # パッチの目印の検証を含む
GH_TOKEN=$(gh auth token) contrib/strait/tests/probe.sh [owner/repo]
```

Unix ソケットを使用するユニットテストは、strait のサンドボックス内のように `AF_UNIX` が使用できない環境ではスキップされます。スキップが 0 件になるのは、ホストで実行した場合だけです。

`tests/probe.sh` は、ネットワーク、bubblewrap、socat がある Linux ホストで、チェックアウトの `contrib/strait/strait` を実際に起動して検証します。変更したソースをそのまま試験するためです。引数には、読み取りを許可する repo を指定します。省略時の値は `Hogeyama/nix-agent-sandbox` です。`GH_TOKEN` には、その repo を読み取れるトークンを指定してください。`strait.json` は、`probe.sh` が一時ディレクトリに作成します。

許可されるべき要求（発行したトークンでの `curl`、`gh api`、`gh pr list`、`git ls-remote`、Claude Code の messages）と並行して、`probe.sh` は次の回避を試行します。

- 外部から持ち込んだトークン、重複したトークン
- 他の repo、REST の書き込み、GraphQL の mutation と経路外の文書、push
- Files API、許可していないホスト
- SOCKS、CONNECT 越しの SSH、独自に TLS を確立するクライアント
- 設定ファイル、strait のソース、パッチ済みの srt への書き込み、作業ディレクトリに仕込んだ `bunfig.toml`
- 追加したホスト（httpbin.org）への、外部から持ち込んだキー、重複したキー、別の認証ヘッダー
- サンドボックス内からの、保留中の要求の参照

承認とホストでの実行も検証します。`probe.sh` はバックグラウンドで保留中の要求を順に調べ、目印（`strait-probe-approve`）がある要求を承認し、`strait-probe-hold` がある要求は保留したままにし、それ以外を拒否します。実行中は、手動で承認しないでください。

依存を変更した場合は、`contrib/strait` で `bun2nix -o bun.nix` を実行し、パッケージに反映してください。

## 未検証の事項

- 要求を 240 秒近く保留した場合に、クライアントや srt のサーバーが先に接続を切断しないか。Node の `requestTimeout` の既定値が 300 秒なので、保留の上限はそれより短く設定しています。
- macOS での動作。srt の別の実装が動作し、パッチもその環境では検証していません。
