# strait のセキュリティ設計

strait のコードをレビュー・変更する人のための文書です。保護の対象、信頼すべきコード、変更後の確認方法を記載します。使用方法は [README](README.md)、全体の構成は [DESIGN.md](DESIGN.md) を参照してください。

## 保護の対象

[脅威モデル](../../docs/architecture/threat-model.md)の被害のうち、strait が阻止するのは次の 4 つです。エージェントやサンドボックス内のプログラムが、制限の回避を試みることを前提とします。

| 被害 | strait の対策 |
| --- | --- |
| A1a：許可していない送信先への流出 | 接続先を、固定のホスト、Artifact の内容の取得先、`hosts` に記述したホストの 443 番に限定する |
| A1b：許可したサービス内での、共有を許可していない相手への流出 | GitHub では repo と操作を検査し、書き込みと他の repo への要求を保留する。許可・承認された要求の認証情報をホスト側で上書きする |
| B2a：ホストのファイルや実行設定の改変 | srt で書き込み先を制限し、strait 自身と設定ファイルへの書き込みも禁止する |
| P1：未信頼の情報源の無人取り込み | GitHub から承認なしに取得できる情報を、指定した repo の特定の経路に限定する |

`hosts` に記述したホストについては、strait は A1b を判定しません。検査するのは認証用のヘッダーだけです。そのホストが README の 3 条件を満たすかどうかは、設定者が判断します。

## 信頼すべきコード

判定に関与するのは `src/core/` だけです。約 2,500 行で、そのうち約 270 行は GraphQL の許可リスト（データ）です。

| ファイル | 役割 |
| --- | --- |
| `main.ts` | srt を設定し、コマンドをサンドボックスで起動する |
| `credentials.ts` | ホスト側の認証ヘッダーを組み立て、クライアントの認証情報を上書きする |
| `policy.ts` | 要求ごとに、許可・保留・拒否を決定する |
| `graphql.ts` | GraphQL の文書を解析し、経路を検査する |
| `body.ts` | 判定に使用する本文を、上限付きで読み込む |
| `approval.ts` | 保留中の要求を保持し、承認用のソケットで待機する |
| `hostexec.ts` | ホストでのコマンド実行の要求を解析・実行し、出力をマスクする |
| `session.ts` | セッション ID と承認用ソケットを確保する |
| `config.ts` | `strait.json` を検証する |
| `selfcheck.ts` | 起動時に、srt のパッチの有効性を検証する |
| `winch.ts` | 端末のサイズの変更（SIGWINCH）を、サンドボックス内のセッションに転送する |

このほかに信頼の対象となるのは、`strait` の launcher、サブコマンドを振り分ける `src/cli.ts`、srt、srt へのパッチ、graphql-js、Bun です。srt と graphql-js のバージョンは `package.json` で固定しています。Nix でビルドする strait（Nix package と配布物）は、srt の `apply-seccomp` を同梱のビルド済みバイナリではなく、上流の同じタグのソースから作り直したものに置き換えます（[ライセンス設計の SRT-3](../../docs/superpowers/specs/2026-10-04-strait-release-license-design.md#srt-3-apply-seccomp-をソースから作り直す)）。配布物は Bun と glibc も同梱し、launcher は同梱の Bun（`libexec/bun`）を使います。

`src/ui/`（ブラウザで動作する `web-ui/` を含めて約 1,400 行）は判定に関与しません。

- `review.ts`（`strait review`）：保留中の要求に、承認または拒否を返却するだけです。
- `web.ts`、`web-ui/`（`strait review web`）：`review.ts` と同じく、一覧の取得と 1 件の承認または拒否だけをブラウザに提供します。
- `statusline.ts`、`notify.ts`：通知するだけです。
- `hostexec_client.ts`（`strait hostexec`）：サンドボックス内で実行されるので、もともと信頼の対象外です。

`src/core/` は `src/ui/` を import しません。`src/boundary_test.ts` がこれを検証します。`main.ts` と UI の接点は、起動するコマンドを置換するフックと、要求の保留を通知するフックの 2 つだけです。どちらも判定を変更できません。そのため、`src/ui/` の変更にセキュリティのレビューは不要です。

例外は `strait review` の表示です。表示する URL、保留の理由、本文は、いずれもサンドボックスから送信されたものです。これらに改行や端末の制御文字が含まれていれば、サンドボックス内のプログラムは、ある要求を別の要求に偽装して承認させることができます。`review.ts` は制御文字と書式文字（Unicode の Cc と Cf）をエスケープして表示します。この処理を変更する場合はレビューしてください。

ブラウザの表示も同様です。`web-ui/app.js` は、要求の内容を `textContent` でのみ表示し、制御文字、書式文字、行区切り文字を `\u{hex}` にエスケープします。そのまま表示する文字列ではバックスラッシュも二重にします。コマンドの引数と環境変数の値はシェルの語として表示します。英数字と一部の記号だけの引数はそのまま、`'` と見えない文字を含まない引数は `'…'` で囲み、それ以外は `$'…'` でバックスラッシュと `'` もエスケープします。`'…'` の中には `'` が現れず、`$'…'` の中のバックスラッシュは必ずエスケープの開始なので、引数の境界はあいまいになりません。GraphQL の variables は `JSON.stringify` の出力として表示し、バックスラッシュを二重にしません。データ由来のバックスラッシュは `JSON.stringify` が二重にしているので、単独のバックスラッシュは必ずエスケープの開始です。GraphQL の本文は、query を改行で分けた行と、variables を字下げした JSON に分けて表示し、受け取った本文そのものも残します。 query の改行とタブは保持し、タブは画面上で 2 文字幅のタブストップとして表示します。それ以外の制御文字・書式文字はエスケープします。重複したメンバーを持つ本文はポリシーが拒否するので、`JSON.parse` の結果は GitHub が解釈する内容と一致します。承認ボタンは表示した要求そのものに結び付いており、その要求が変化、期限切れ、消失すると無効になります。別の要求に対して動作することはありません。`web.ts` は、ホストでのコマンドの形式が不正な要求を一覧から除外します。コマンドを持たない通常の要求として表示されることはありません。これらの処理を変更する場合もレビューしてください。

もう 1 つの例外は `web.ts` の要求の検査です。トークン、`Origin`、`Host` の検査と、API を一覧と 1 件の決定に限定していることが、ブラウザ側の承認の権限を守っています（[承認経路の保護](#承認経路の保護)）。この検査が崩れると、ホストの任意のプロセスやサイトが要求を承認できます。変更する場合はレビューしてください。

## srt へのパッチ

srt 0.0.77 は、HTTP プロキシへの要求についてだけ、TLS を終端して `filterRequest` を呼び出します。次の 2 つの経路では、要求が判定を経ずに許可済みのホストへ到達します（[srt-filter-bypass](../../docs/architecture/experiments/srt-filter-bypass/README.md) で実測）。

- **SOCKS**：プロキシのポートは SOCKS5 も受け付け、内容を検査せずに中継します。サンドボックス内のプログラムは、`HTTPS_PROXY` を `socks5h://` に変更するだけで、任意のトークンを GitHub に送信できます。
- **TLS 以外の CONNECT**：TLS で開始しない CONNECT の通信は、そのまま中継されます。`github.com:22` や `ssh.github.com:443` への SSH が、この経路で到達しました。

[patches/](patches/) のパッチにより、mux は SOCKS の接続を切断し、HTTP プロキシは TLS 以外の CONNECT を切断します。

同じパッチには、`filterRequest` が `{action: "respond", ...}` を返却した場合に、srt が上流に送信せずにその応答をクライアントに返却する変更も含まれます。この変更は、ホストでのコマンド実行に使用します。パッチがない srt はこの判定を拒否として扱うので、安全側に動作します。

パッチの有効性は、ビルド時と起動時に検証します。

1. **ビルド時**：`nix build .#strait` は、パッチ済みの srt に変更（SOCKS の切断、TLS 以外の CONNECT の切断、respond、認証ヘッダー上書き、上書き失敗時の拒否）の目印があるかを検証し、欠落していれば失敗します。
2. **起動時**：`selfcheck.ts` が、稼働中のプロキシに SOCKS と TLS 以外の CONNECT を実際に送信します。どちらかが中継された場合、strait は起動しません。パッチを 1 つずつ除去し、いずれの欠落も検出できることを確認済みです。
3. **起動時（全セッション）**：認証ヘッダーの上書きフックと、例外を秘密を含まない拒否にする変更を検証します。欠落していれば起動しません。
4. **起動時（hostExec）**：`hostExec` が有効な場合は、respond の変更の有無も検証します。

srt のバージョンを更新する場合は、パッチを再適用し、これらの検証がすべて成功することを確認してください。

## 判定の要点

許可リストにないホストへの接続は、`filterRequest` に到達する前に、srt が CONNECT の段階で拒否します。許可リストは、固定の 3 ホスト、Artifact の内容の取得先（`*.frame.claudeusercontent.com`）、`hosts` に記述したホスト、`hostExec` が有効な場合の `hostexec.strait.invalid` です。

許可リストのホストへの要求を、`policy.ts` は次の順序で検査します。

1. **通信の検査**：HTTPS であること、443 番であること、URL に認証情報がないこと。
2. **要求先の正規形**：srt は、クライアントが送信した要求先をそのまま上流に転送します。一方、strait が判定に使用する URL の解析では、`..`、`%2e`、`\` が解決されます。解析によって要求先が変化する要求は拒否します。これにより、strait が判定するパスと、上流が受信するパスが常に一致します。
3. **認証情報**：`Authorization`、`x-api-key`、`Cookie`、query の `access_token` を検査します。ホスト側に認証情報がある場合、クライアントの認証用ヘッダーは値に関係なく上書きできます。ホスト側に認証情報がなければ、認証用ヘッダーのある要求を拒否します。Cookie と query の access_token は常に拒否します。
4. **ホストごとのポリシー**：Anthropic の API では固定のエンドポイントだけ、GitHub の API では指定した repo への読み取りの操作だけ、git では fetch だけを許可します。`hosts` のホストへの要求は、すべて許可します。Artifact の内容の取得先への要求は、すべて保留します。取得先のホストは Artifact ごとに異なるので、srt の許可リストにはワイルドカードで登録し、`policy.ts` でサブドメインを 1 階層に限定します。

1〜3 の検査に合格し、4 のポリシーに該当しない要求は、保留されて人の承認を待ちます。1〜3 の検査で不合格となった要求は、人に回さずに拒否されます。外部から持ち込まれたトークンを認証ヘッダーに付けても、上流にはホスト側の認証情報だけが届きます。

### 認証情報

サンドボックス内の `GH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` などは、srt が生成したダミーの値です。全マスク対象を `injectHosts: []` で登録するため、ヘッダー・本文への sentinel 置換は無効です。認証情報は `credentials.ts` がホスト環境から組み立て、許可・承認の後、hop-by-hop ヘッダーの除去後に設定します。認証ヘッダーの省略、外部トークン、他ホストの sentinel、重複ヘッダーでも、認証主体は変わりません。

GitHub API は `Authorization: Bearer <GH_TOKEN>`、HTTPS の git は `Authorization: Basic <base64(x-access-token:GH_TOKEN)>` です。git が認証ヘッダーを送るため、Basic 値全体のダミーを `http.extraHeader` に設定する仕組みは残します。Anthropic は `CLAUDE_CODE_OAUTH_TOKEN` があれば OAuth、なければ `ANTHROPIC_API_KEY` を選びます。両方の環境変数がある場合も、上流には選んだ方式だけを送ります。

上書きは `Authorization`、`x-api-key`、追加ホストの指定ヘッダーを除去してから行います。本文・URL・その他のヘッダーを認証情報へ変換しません。policy と承認 UI に渡すのは要求と、ホスト側の認証情報の有無・ヘッダー名だけです。実値は渡しません。上書き関数が失敗した場合は、秘密を含み得る例外内容を表示せず、汎用の 403 で終了します。

上流が認証ヘッダーそのものを反射すると、実値がサンドボックスへ戻る可能性は残ります。認証ヘッダーを返却しないことは、接続先への信頼条件です。追加ホストは body など別経路の認証で主体を変更できないサービスに限ります。今回の上書きはレスポンス全体のマスクを提供しません。

### GraphQL

strait が本文を読み込むのは、`POST /graphql` と hostexec の要求（`POST https://hostexec.strait.invalid/run`）だけです。GraphQL の本文は、256 KiB 以下の UTF-8 の JSON で、メンバーが重複しない 1 つの `{query, variables, operationName}` オブジェクトである必要があります。

strait は、次の条件をすべて満たす文書だけを許可します。

- operation がすべて `query` である。
- 選択されたフィールドがすべて、`graphql.ts` の `GITHUB_FIELDS` の経路上にある。alias を除去し、fragment を使用箇所で展開し、型条件を無視して、すべての分岐を検査します。`@skip` や `@include` があっても検査の対象です。
- すべての `repository` について、`owner` と `name` が `trustedGitHubRepos` のいずれか 1 つを指す。`owner/*` の規則は、その owner のすべてのリポジトリを指します。
- 解析可能である。未知の directive、引数・変数・fragment の重複、未定義や循環する fragment、トークン数・深さ・展開量の上限の超過がある文書は、解析不能として許可しません。

`GITHUB_FIELDS` は、gh 2.46、2.90、2.102 の主要なコマンドが送信する query から作成しました（`src/core/testdata/gh_queries.json`）。2.90 以降の分は、各コマンドが送るすべての要求を収録し、`--json` で選べるフィールドもすべて含めています。末端はすべてスカラーで、他のリポジトリの内容に到達する経路（`owner { repositories }`、`viewer { starredRepositories }` など）は含みません。他のリポジトリを指す経路（`parent`、`closingIssuesReferences` など）は、ID、名前、番号、URL で止まります。

例外は、つながった issue（`parent`、`subIssues`、`blockedBy`、`blocking`）のタイトルです（`LINKED_ISSUE_TITLES`）。gh 2.102 の `issue view` は常にこれを選びます。依存先（`blockedBy`、`blocking`）には他の owner の issue も指定できます（別アカウントのリポジトリの issue で確認済み）。親と子は同じ owner に限られますが、`trustedGitHubRepos` にないリポジトリのこともあります。どちらも、タイトルは `trustedGitHubRepos` の外で書かれた文章になり得ます。gh は 4 つをまとめて選ぶので、同じ owner の親と子だけを許可しても `issue view` は通りません。そのため 4 つを同じ扱いにしています。既定では許可せず、`trustLinkedIssues` を有効にした場合だけ許可します。strait は応答を見ないので、つながった issue が許可したリポジトリにあるかどうかは判定できません。この設定は、どこのリポジトリのタイトルでも取り込むという P1 の例外です。

`repository` の外で許可するのは、gh がフィールドの有無を調べるためのスキーマの問い合わせ（`__type { fields { name } enumValues { name } }`）と、`viewer { login }` だけです。どちらもリポジトリの内容を返しません。`gh pr status` と `gh search` は、リポジトリに限定されない `search` を使うので、保留されます。許可リストの末端と、収録した query の末端が完全に一致することをテストで検証しています。経路を追加する場合は、その query を testdata に追加してください。

条件を満たさない文書は保留され、理由にはすべての違反が列挙されます。この規則は nas の[フィールド経路ポリシー](../../docs/superpowers/specs/2026-09-20-graphql-field-path-policy-design.md)を簡略化したものです。nas と異なり、owner と name の両方を要求します。

## 承認経路の保護

承認用のソケットにサンドボックスから到達できれば、エージェントは自身の要求を承認できてしまいます。strait はソケットを `$XDG_RUNTIME_DIR/strait`（未設定の場合は一時ディレクトリの `strait-<uid>`）に配置し、次の 3 つの方法で保護します。

- 起動時に、ディレクトリの所有者が自分であり、モードが 0700 であることを検証します。
- Linux では、srt の seccomp フィルタが、サンドボックス内での `AF_UNIX` のソケットを遮断します。
- strait はこのディレクトリを `denyRead` に追加します。srt が seccomp の補助プログラムなしで動作する場合でも、サンドボックス内からはこのディレクトリが空の tmpfs に見えます。そこにソケットを作成しても、ホスト側には出現しません。

`strait review web` は、localhost の空いているポートで待機します。localhost のポートには、ホストの任意のプロセスや、ブラウザで開いた任意のサイトから接続できます。そのため、到達できることは権限になりません。権限を持つのは、起動時に生成する 256 bit のトークンを持つ者だけです。

- トークンは制御端末（`/dev/tty`）にだけ出力します。標準出力と標準エラー出力には出力しません。これらはサンドボックスから読めるファイルにリダイレクトされている可能性があるためです。制御端末がない場合は起動しません。
- トークンは URL のフラグメントで渡します。ページは最初の要求の前に、アドレスバーと履歴からフラグメントを削除します。
- API はすべて POST で、`Authorization` ヘッダのトークン、完全に一致する `Origin` と `Host` を要求します。他のサイトのページは、これらをそろえた要求を送信できません。CORS のヘッダは返却しません。`Host` の検査は DNS rebinding も防ぎます。
- API は、保留中の要求の一覧と、REF を指定した 1 件の承認または拒否だけです。ソケットへの任意のコマンドの転送、要求の保留、ポリシーの変更はできません。

トークンが漏れれば、それを持つ者は保留中の要求を読み、承認できます。リンクをサンドボックス内や他のサイトに貼り付けないでください。ホストのユーザー、端末、ブラウザ、ブラウザの拡張機能が侵害されている場合は保護できません。

常駐する `strait review` は、再読み込みのために fzf を localhost のポートで待機させます。fzf はこのポート経由で `execute` も受け付けるので、`strait review` は `FZF_API_KEY` を設定して、他のプロセスからの操作を防止しています。サンドボックスは別のネットワーク名前空間にあるので、このポートにはそもそも到達できません。

## ホストでのコマンド実行の経路

Linux の srt は Unix ソケットを遮断するので、nas のようにソケット経由でホストのブローカーに接続することはできません。srt の `mitmProxy` の設定も、TLS の終端と併用できません（`sandbox-manager.js` が拒否します）。

そこで `strait hostexec` は、実行の要求を `POST https://hostexec.strait.invalid/run` として srt のプロキシに送信します。このホスト名は実在しません。strait がこのホスト名を許可リストに登録するのは、`hostExec` が有効な場合だけです。strait はこの要求を保留し、承認後にホストで実行し、respond のパッチで結果を返却します。srt はこのホスト名の名前解決も接続も行いません。外部への出口は、`filterRequest` の 1 か所のままです。

実行するコマンドの環境変数は、ホストの `PATH` と `HOME` に、要求で宣言された変数を追加したものだけです。strait 自身の環境変数は、本物のトークンを含むため継承しません。出力に含まれる本物の認証情報は、マスクしてから返却します。

## サンドボックスから変更できないファイル

strait の設定ファイルと strait 自身のファイルは、次回の起動時にホストで使用されます。サンドボックスから変更できると、エージェントが次回のポリシーを選択できてしまいます。そのため、設定にかかわらず、次のパスを `denyWrite` に追加します。

- 設定ファイル
- strait のディレクトリ全体（`STRAIT_ROOT`）：launcher、ソース、パッチ、パッチ済みの srt。配布物ではこれが展開先全体になり、同梱の Bun と共有ライブラリも含みます
- 作業ディレクトリの `.claude`

`STRAIT_ROOT` がディレクトリ全体を指すことは、`src/boundary_test.ts` で固定しています。ファイルの移動によって、保護の範囲が縮小しないようにするためです。

Linux の srt が保護できるのは、既存のパスだけです。設定ファイルがない場合に、空のポリシーで起動せずエラーとするのはこのためです。同じ理由で、strait は起動前に空の `.claude/commands` と `.claude/agents` を作成します。srt はこの 2 つを常に保護しようとしますが、読み取り専用の `.claude` の中には、bubblewrap がマウントポイントを作成できないためです。

strait の起動には、必ず launcher を使用してください。`bun src/cli.ts` で起動すると、bun が作業ディレクトリの `bunfig.toml` と `.env` を読み込みます。作業ディレクトリはサンドボックスから書き込み可能なので、そこに仕込まれた `preload` が、次回の起動時にホストで実行されてしまいます。launcher は `--config=<strait>/bunfig.toml --no-env-file` を指定し、どちらも読み込ませません。

## 変更後の確認

```sh
bun run test:strait-unit                                # リポジトリのルートで実行。contrib/strait で bun install が必要
node_modules/.bin/tsc -p contrib/strait/tsconfig.json   # 事前に contrib/strait で bun install
nix build .#strait                                      # パッチの目印の検証を含む
nix build .#strait-bundled                              # 配布物（下記の probe で確認する）
GH_TOKEN=$(gh auth token) contrib/strait/tests/probe.sh [owner/repo]
```

転送テストは実際のパッチ済み srt manager とローカル TLS 上流を使い、試験用の秘密で上書き、本文の保持、GET・チャンク境界、承認・拒否、例外の秘匿を検証します。Linux の bwrap・socat とローカル listen が必要で、これらがない場合はスキップします。必須パッチの欠落はスキップせず失敗します。

Unix ソケットを使用するユニットテストは、strait のサンドボックス内のように `AF_UNIX` が使用できない環境ではスキップされます。スキップが 0 件になるのは、ホストで実行した場合だけです。

`tests/probe.sh` は、ネットワーク、bubblewrap、socat がある Linux ホストで、チェックアウトの `contrib/strait/strait` を実際に起動して検証します。変更したソースをそのまま試験するためです。引数には、読み取りを許可する repo を指定します。省略時の値は `Hogeyama/nix-agent-sandbox` です。`GH_TOKEN` には、その repo を読み取れるトークンを指定してください。`strait.json` は、`probe.sh` が一時ディレクトリに作成します。

配布物を変更した場合は、展開したツリーに対しても probe を実行します。同梱の Bun と共有ライブラリへの書き込みが拒否されること、作り直した `apply-seccomp` が `AF_UNIX` を遮断することも確認します。

```sh
./result/strait --extract ~/.cache/strait-release-test   # result は nix build .#strait-bundled の出力
GH_TOKEN=$(gh auth token) STRAIT_DIR=~/.cache/strait-release-test contrib/strait/tests/probe.sh
```

許可されるべき要求（発行したトークンでの `curl`、`gh api`、`gh pr list`、`git ls-remote`、Claude Code の messages）と並行して、`probe.sh` は次の回避を試行します。

- 認証ヘッダーの省略、外部から持ち込んだトークン、重複したトークンがホスト側の認証で通ること
- 他の repo、REST の書き込み、GraphQL の mutation と経路外の文書、push
- Files API、許可していないホスト
- SOCKS、CONNECT 越しの SSH、独自に TLS を確立するクライアント
- 設定ファイル、strait のソース、パッチ済みの srt への書き込み、作業ディレクトリに仕込んだ `bunfig.toml`
- 追加したホスト（httpbin.org）への外部キー、重複キー、別の認証ヘッダーが上書きされること。反射には試験専用の値だけを使う
- サンドボックス内からの、保留中の要求の参照

承認とホストでの実行も検証します。`probe.sh` はバックグラウンドで保留中の要求を順に調べ、目印（`strait-probe-approve`）がある要求を承認し、`strait-probe-hold` がある要求は保留したままにし、それ以外を拒否します。実行中は、手動で承認しないでください。

依存を変更した場合は、`contrib/strait` で `bun2nix -o bun.nix` を実行し、パッケージに反映してください。

## 未検証の事項

- 要求を 240 秒近く保留した場合に、クライアントや srt のサーバーが先に接続を切断しないか。Node の `requestTimeout` の既定値が 300 秒なので、保留の上限はそれより短く設定しています。
- macOS での動作。srt の別の実装が動作し、パッチもその環境では検証していません。
