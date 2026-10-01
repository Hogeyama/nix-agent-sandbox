# sumi serve の TCP 待ち受けと `--server`: srt の中から一覧を持たずにマスクする

## 目的

Claude Code の Bash sandbox (srt) を有効にした環境で、エージェントにシークレットファイルを読ませずに sumi のマスクを使えるようにする。

今の sumi には次の 2 つの構成しかない。

- `--secrets-file F`: hook と `sumi run` が F を読む。srt の `denyRead` で F を隠すと、sandbox の中で動く `sumi run` も F を読めなくなる。隠さなければ、エージェントは F を `cat` できる。
- `--socket SOCK`: `sumi serve` か `nas-mask-filter --serve` に Unix ソケットで問い合わせる。srt は Linux で `socket(AF_UNIX)` を seccomp で塞ぐので、sandbox の中の `sumi run` は接続できない。

Claude Code の sandbox の中で動くのは `CLAUDE_CODE_SHELL_PREFIX` (= `sumi run`) で、hook は sandbox の外で動く (利用者が確認済み)。
したがって、塞がれているのは `sumi run` からブローカーへの経路だけである。

srt には、`network.allowedDomains` に IP リテラルを書くと、srt の HTTP proxy がその宛先へ `CONNECT` を通す機能がある。
`sumi serve` が `127.0.0.1:PORT` で TCP を待ち受け、sandbox の中の `sumi run` が proxy 経由でそこへつなげば、一覧を sandbox に入れずにマスクできる。

### 実測 (2026-10-02, Linux, srt 0.0.77, Claude Code 2.1.285)

`.local/srt-tcp-probe/` (gitignore 対象) のスクリプトで、srt CLI 単体と、Claude Code の sandbox の `CLAUDE_CODE_SHELL_PREFIX` の両方から確かめた。結果は同じだった。

| sandbox の中から | 結果 |
|---|---|
| `denyRead` にしたファイルを読む | ENOENT |
| `socket(AF_UNIX)` で接続 | EPERM |
| `127.0.0.1:PORT` へ直接 TCP 接続 | ECONNREFUSED (別の network namespace) |
| proxy (`HTTP_PROXY`) に `CONNECT 127.0.0.1:許可したポート` | `200 Connection Established`、その後ホストのサーバーと双方向に通信できる |
| proxy に `CONNECT 127.0.0.1:許可していないポート` | `403 Forbidden` |

Claude Code の設定は `sandbox.network.allowedDomains: ["127.0.0.1:PORT"]` で通った。
prefix には、Claude Code が組み立てたシェル文字列が引数 1 個で渡る。`sumi run --shell PATH COMMAND` の受け取り方と合う。

## 想定する使い方

```bash
# ホスト
sumi serve --secrets-file ~/.claude/sumi/secrets.txt \
  --listen tcp://127.0.0.1:47321
sumi init --agent claude --server tcp://127.0.0.1:47321
```

TCP の構成は、一人で使うホストだけを対象にする (下の「対象にするホスト」)。

```jsonc
// ~/.claude/settings.json に利用者が足す
"sandbox": {
  "enabled": true,
  "allowUnsandboxedCommands": false,
  "network": { "allowedDomains": ["127.0.0.1:47321"] },
  "filesystem": { "denyRead": ["~/.claude/sumi/secrets.txt"] }
}
```

Read / Grep ツールは srt の対象外なので、`permissions.deny` の `Read(~/.claude/sumi/secrets.txt)` も要る。これは README に書く。

## CLI

### アドレスの形式 (ADDR)

`--listen` と `--server` は同じ形式を受け付ける。Docker の `-H` / `DOCKER_HOST` と同じ流儀である。

| 書き方 | 意味 |
|---|---|
| `/path/mask.sock` | Unix ソケット (今と同じ) |
| `unix:///path/mask.sock` | 同上 |
| `tcp://127.0.0.1:PORT` / `tcp://[::1]:PORT` | TCP。ループバックアドレスのリテラルだけを受け付ける。ホスト名 (`localhost` も含む) と、ループバック以外のアドレスは usage エラー |

PORT は 1〜65535 の固定値を必須にする。`0` (OS に選ばせる) は受け付けない。`allowedDomains` に書く値が起動ごとに変わると使えないからである。
相対パスの Unix ソケットは今と同じく受け付ける。`unix://` の後ろは絶対パスだけにする。

### server: `sumi serve`

```
sumi serve --secrets-file F --listen ADDR
```

- `--listen` は 1 回だけ受け付ける。Unix と TCP を 1 プロセスで同時に待ち受けることはしない。

### client: `hook` / `run` / `init`

```
sumi hook --agent claude post-tool --server ADDR
sumi run  --server ADDR [--shell PATH] COMMAND
sumi init --agent claude --server ADDR ...
```

- `--server` は `--secrets-file` と同時に指定できない。今の `--socket` と同じ扱いである。
- `init` は `--server` の値を、生成する hook と `CLAUDE_CODE_SHELL_PREFIX` にそのまま書き出す。
- `--socket` は削除する。`--socket PATH` は `--server PATH` に置き換わる。CHANGELOG の Changed に書く。

## 対象にするホスト

TCP の構成は、他のユーザーがログインしない、一人で使うホストだけを対象にする。README にもそう書く。他のユーザーがいるホストでは Dev Container などの Unix ソケットの構成を案内する。

`127.0.0.1:PORT` には所有者という考え方がない。同じホストの他のユーザーは、次の 2 つができる。

- **接続する**: 値を推測して送り、伏せられるかどうかで答え合わせができる。
- **待ち受けを差し替える**: `sumi serve` が止まっている間 (起動前、再起動中、落ちた後) に同じポートで待ち受ければ、`sumi run` と hook はその偽のサーバーにコマンドの出力を送る。出力に含まれるシークレットが他のユーザーに渡り、偽のサーバーが出力をそのまま返せば、エージェントにもマスクされずに届く。

Unix ソケットの構成では、0700 のディレクトリと 0600 のソケットが両方を防いでいる。TCP ではどちらも防げない。

クライアントがトークンを送る方式では、1 つ目しか防げない。偽のサーバーは、送られてきたトークンをそのまま受け取り、続く出力も受け取れる。
2 つ目まで防ぐには、0600 のファイルに置いた共有の値を使ったチャレンジレスポンスで、クライアントがサーバーを確かめてから出力を送る必要がある。
これはプロトコル、鍵ファイルの管理、テストを大きく増やす一方で、一人で使うホストでは何も守らない。今のホストの多くは一人で使うものなので、持たないことにした。

## proxy 経由の接続

TCP の ADDR に対して、クライアントは次の 1 つの規則で経路を決める。フォールバックはしない。

- `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy` の順に最初に見つかった値が `http://` で始まり、かつ proxy のホストがループバック (`127.0.0.1`、`[::1]`、`localhost`) なら、その proxy に `CONNECT 127.0.0.1:PORT` を送る。
- それ以外 (proxy が無い、ループバック以外、`http://` 以外) なら、ADDR へ直接つなぐ。

`NO_PROXY` は見ない。srt が `NO_PROXY` に `localhost` などを入れていると、proxy を使わずに直接つなぎに行き、sandbox の中では届かなくなる。

`CONNECT` の要求と応答:

- proxy の URL にユーザー情報があれば、`Proxy-Authorization: Basic` を付ける。srt の README には、Windows で `http://srt:<token>@127.0.0.1:…` の形で proxy の認証を渡すと書かれている。Linux での実測では、この処理を入れたクライアントで通った (ユーザー情報が付いていたかは記録していない)。
- 応答のヘッダは `\r\n\r\n` まで、上限 8 KiB まで読む。状態行が `HTTP/1.x 200` でなければ接続できない扱いにする。上限を越えた場合も同じ。
- ヘッダの後は、直接つないだ場合と同じくストリームを流す。

### なぜループバックの proxy に限るか

利用者が社内の proxy を `HTTP_PROXY` に設定している環境で、`CONNECT 127.0.0.1:PORT` を送ると、proxy は proxy 自身のホストのループバックへつなぎに行く。
そこに何かが待ち受けていれば、ツールの出力がそのホストへ流れる。
srt の proxy はホストのループバックで待ち受け、sandbox の中にはループバックで見えるので、ループバックに限っても srt では困らない。

### なぜ「直接 → 失敗したら proxy」としないか

sandbox の中の network namespace では `127.0.0.1:PORT` が空いている。エージェントはそこで自前の待ち受けを立てられる。
直接つなぐのを先に試すと、`sumi run` はエージェントの待ち受けにコマンドの出力を送り、そこから返ったマスクされていない出力を流してしまう。
Dev Container の構成でソケットのディレクトリを読み取り専用で mount しているのは、ソケットを差し替えられるのを防ぐためだが、これはそれと同じ種類の差し替えである。
proxy があるときは proxy だけを使えば、`sumi run` が sandbox の中の待ち受けに接続することはない。srt の proxy のポートは srt の socat が先に押さえている。

## 失敗時の扱い

今の `--socket` と同じにする。

- hook: 出力を差し替えて伏せ、プロンプトを止める。
- `run`: 出力を捨て、終了コード 121 で終わる。

TCP の接続失敗と、proxy の拒否 (403 など) もここに入る。
`masker.UNAVAILABLE_REASON` の文言は変えない。原因ごとの詳細は stderr に出さない。hook の stderr はエージェントに見えうるからである。

## ブローカーのプロトコル: 入力の終わりを区切りで伝える

今のプロトコルは、クライアントが `shutdown(SHUT_WR)` (half-close) で入力の終わりを伝え、サーバーが保持中の末尾をマスクして返してから閉じる。
srt の proxy はこの half-close を通さない。

### 実測 (2026-10-02, Linux, srt 0.0.77)

`.local/srt-tcp-probe/halfclose.sh` で、srt の中から proxy 経由でホストのサーバーへつなぎ、`hello` を送って half-close した。

- サーバーは `hello` と EOF を受け取り、1 ms 後に返事を送った (サーバー側のログ)。
- クライアントには何も届かず、EOF で終わった。

クライアントが half-close せずに待つ場合は、返事が届き、サーバーの close も EOF として届く (最初の実測)。
proxy の経路では、クライアントが half-close した時点で逆向きも閉じられる。

### 新しいプロトコル

Unix ソケットと TCP で同じものを使う。

- **クライアント → サーバー**: `[長さ: 4 バイト、ビッグエンディアン][その長さのバイト列]` を繰り返す。長さは 1 以上、上限は relay の `CHUNK_SIZE` (64 KiB)。**長さ 0 のフレームが入力の終わり**。クライアントは half-close しない。
- **サーバー → クライアント**: 今と同じく、マスク済みのバイト列を区切りなしで流す。終わりのフレームを受け取ったら保持中の末尾をマスクして送り、送り切ったら閉じる。**サーバーの close が出力の終わり**。

サーバーは次の場合、保持中の末尾を送らずに接続を閉じる。

- 長さが上限を越えている。
- 終わりのフレームの前に EOF になった (クライアントが落ちた)。

終わりのフレームを読んだ後は、その接続から読まない。後から届いたバイトは捨て、末尾をマスクして送り切ったら閉じる。
送る末尾はマスク済みなので、余分なバイトがあっても漏れは起きない。余分なバイトを送るのはクライアントの不具合である。本文として数えたデータが捨てられた場合は、次の長さの照合で検出できる。本文の長さが変わらない余分なバイト (終わりのフレームを 2 回送った場合など) は検出しない。

### 応答が最後まで届いたかの判定

マスクは長さを変えない。クライアントは、送ったフレームの本文の合計バイト数と、受け取ったバイト数を数える。
サーバーが閉じたとき、次のどちらかなら失敗にする (hook は伏せて止め、`run` は 121)。

- 終わりのフレームを送り切っていない (今の「half-close より前にサーバーが閉じたのは切り捨て」と同じ)。
- 受け取ったバイト数が、送った本文の合計と一致しない。

終わりのフレームを送ったことは、サーバーが処理を終えたことを意味しない。サーバーが末尾を返さずに閉じても、送信の完了だけを見ていると出力が欠けたまま成功になる。
長さの照合は今の `maskOnce` が行っているもので、これを `Relay` に持たせ、`supervise.run` も同じ判定を使う。
half-close のプロトコルにも同じ穴 (サーバーが途中で落ちると `run` が欠けた出力で 0 を返しうる) があり、これで併せて塞がる。

サーバーは、フレームの境界とマスクの境界を関係づけない。フレームの中身をつなげたバイト列を今と同じストリームとして扱うので、シークレットがフレームをまたいでもマスクされる。

### 誰が変わるか

プロトコルの両端は `lib/process-supervisor` にある (サーバーは serve.zig、クライアントは relay.zig の `Relay` と `maskOnce`、それを使う `supervise.run`)。
テストの中には、プロトコルを直接話すものがある (relay.zig と masker.zig のテスト用ブローカー、`src/stages/maskfs/mask_filter_integration_test.ts`、`src/stages/launch/integration_test.ts` の偽 sumi など)。これらも新しいプロトコルに合わせる。

nas-mask-filter と、nas が同梱する sumi は同じソースからビルドされる (`flake.nix`)。古いクライアントと新しいサーバーが組み合わさることはないので、互換性のための切り替えは持たない。

## コード構成

| 変更 | 内容 |
|---|---|
| `lib/process-supervisor/address.zig` (新規) | ADDR の解釈 (`/path`、`unix://`、`tcp://`)。serve と relay の両方が使う |
| `lib/process-supervisor/serve.zig` | `run` が Unix のパスの代わりに ADDR を受け取る。TCP の listener を足す。入力をフレームとして読む |
| `lib/process-supervisor/relay.zig` | `Relay.connect` が ADDR を受け取る。TCP の直接接続と、proxy の `CONNECT` を足す。入力をフレームで送り、half-close の代わりに終わりのフレームを送る |
| `lib/process-supervisor/supervise.zig` | `run` の引数を ADDR に替える。half-close の呼び出しを終わりのフレームに替える |
| `contrib/sumi/masker.zig` | `Source.socket` を `Source.server` (ADDR) に替える。`--socket` を受け付けなくする |
| `contrib/sumi/main.zig` | `serve` の `--listen` の解釈 |
| `contrib/sumi/claude/init.zig` ほか | `--server` を書き出す |
| `src/mask-filter/mask_filter.zig` | serve.zig の新しい `run` を、Unix の ADDR で呼ぶ。`--supervise --socket` は nas-mask-filter 自身の CLI なので変えない |
| `src/stages/maskfs/mask_filter_service.ts`、`src/stages/agent_hooks/settings.ts`、`src/docker/embed/entrypoint.sh` | nas が sumi に渡す `--socket` を `--server` に替える |
| `contrib/sumi/README.md`、`contrib/sumi/CHANGELOG.md` | srt の構成例と、`--socket` の削除 |

nas の変更は引数名の置き換えだけで、nas は今後も Unix ソケットだけを使う。
security-constraints の N1 (コンテナからホストへの通信は Unix socket 経由のみ) には触れない。TCP の待ち受けは sumi を単体で使う利用者のためのものである。

nas は同じリポジトリの sumi を同梱して使うので、sumi の `--socket` の削除と nas 側の置き換えは同じ変更でそろえる。
これが成り立つこと (nas が別のバージョンの sumi を取ってこないこと) は、計画の段階で flake.nix と配布物の組み立てを読んで確かめる。

## テスト

- unit (`address.zig`): 受け付ける形と、拒否する形 (ホスト名、`localhost`、ループバック以外、ポート 0・範囲外・欠落、`unix://` の相対パス、未知のスキーム)。
- unit (`serve.zig`): TCP で待ち受けたときも、Unix ソケットと同じマスクが返る。シークレットがフレームの境界をまたいでもマスクされる。長さの上限越えと、終わりのフレームの前の EOF で、末尾を送らずに閉じる。終わりのフレームと余分なバイトが同時に届いても、遅れて届いても、末尾を送り切ってから閉じる (余分なバイトは処理しない)。
- unit (`relay.zig`、`supervise.zig`): 入力がフレームで送られ、終わりのフレームで出力が閉じられる。half-close を使わない。サーバーが終わりのフレームを受け取った後、末尾を返さずに閉じると、`maskOnce` も `supervise.run` も失敗する (`run` は子が 0 で終わっても 121)。proxy の規則 (変数の優先順、ループバックの判定、`http://` 以外は直接)、`CONNECT` の応答の解釈 (200、403、ヘッダの上限越え)、`Proxy-Authorization` の付与。テスト用の proxy はテスト内で立てる。
- unit (`main.zig`): `serve` の `--listen` が 3 つの形を受け付け、不正な形を usage エラーにする。
- black-box (`contrib/sumi/tests/run-tests.sh`): TCP の `sumi serve` に対して `run` と hook がマスクできる。サーバーが止まっていると、`run` は 121、hook は伏せて止める。最小の CONNECT proxy をスクリプト内で立て、`HTTP_PROXY` 経由でも通ることを確かめる。`--socket` が usage エラーになる。
- nas: `--socket` を `--server` に替えた既存のテスト (`mask_filter_service_test.ts`、`agent_hooks` のテスト、`launch/integration_test.ts` の偽 sumi) が通る。
- nas: プロトコルを直接話すテスト (`mask_filter_integration_test.ts`、`launch/integration_test.ts` の偽 sumi ほか) を新しいプロトコルに合わせて通す。
- 手動 (ホスト): `.local/srt-tcp-probe/claude.sh` と同じ形で、本物の `sumi serve` と `sumi init --server tcp://…` を使い、Claude Code の sandbox で Bash の出力が伏せられることを確かめる。結果は `contrib/sumi/tests/manual-validation.md` に記録する。

## 範囲外

- `--listen` の複数指定 (Unix と TCP を 1 プロセスで待ち受ける)。
- `allowUnixSockets` が使える macOS での Unix ソケットの構成。
- nas 自身が TCP を使うこと。
- 他のユーザーがいるホストでの TCP の構成 (上の「対象にするホスト」)。
- アイドル接続の刈り取り。

## Why — なぜこのアプローチを選んだか

srt の Linux の制限 (seccomp で AF_UNIX を塞ぐ、network namespace を外す) の中で、ホストのプロセスへ届く経路のうち、srt が機能として用意しているのは HTTP / SOCKS の proxy だけである。
`allowedDomains` の IP リテラルは srt の README で「明示的な選択」として扱われており、srt の穴を突く方法ではない。将来の srt で塞がれる心配が小さい。
許可するのは 1 つのポートだけで、`allowAllUnixSockets` のように他の Unix ソケットまで開かない。

ADDR の形式を Docker 式にしたのは、待ち受け側と接続側で同じ文字列を使い回せ、素のパスを今と同じく受け付けられるからである。
接続側の名前を `--server` にしたのは、`sumi serve` と対で読め、kubectl の `--server URL` のように「つなぐ先」を指す名前として通りがよいからである。
`--socket` は MySQL の `--socket` のように Unix ソケットを連想させるので、TCP を受け付ける名前としては残さない。リリース済みの `--socket` を実際に使っていたのはほぼ nas 自身で、README の例も nas 内部のパスだったので、別名も残さない。

入力の終わりを half-close ではなくフレームで伝えるのは、srt の proxy が half-close を通さないからである (実測)。
Unix ソケットも同じプロトコルにそろえたのは、開発途中のいまは、変更の小ささより、プロトコルが 1 つで済む全体の小ささを優先するからである。

TCP の構成を一人で使うホストに限ったのは、他のユーザーから守るには相互認証が要り、その費用が一人で使うホストでの利点に見合わないからである。他のユーザーがいるホストには、Unix ソケットの構成がすでにある。

## Why Not — なぜ他の案を選ばなかったか

- **`allowAllUnixSockets: true` で今の Unix ソケットを使う** — sandbox の中から、見えるすべての Unix ソケットに接続できるようになる。docker.sock や D-Bus のセッションバスに届けば、sandbox の外でシークレットファイルを読める。一覧を守るために、一覧を渡すより大きな穴を開けることになる (2026-10-01 の sumi serve の設計でも同じ理由で棄却)。
- **socketpair の DGRAM ソケットをパスへ connect し直す** — srt の seccomp の穴を突く方法で、塞がれれば動かなくなる。
- **制御用 fd を継承させる** — node と Bun の spawn が stdio 以外の fd を閉じるので、srt と Claude Code の 2 か所で落ちる (`docs/superpowers/probes/srt-fd-inherit/README.md`)。
- **prefix をやめて hook だけでマスクする** — hook は sandbox の外で動くので Unix ソケットに届く。ただし、sumi が prefix と hook の両方を使う構成で保護している範囲を変えることになり、その評価はこの設計では行っていない。今の保護範囲を保ったまま srt で動かすことを優先した。
- **クライアントがトークンを送る** — 他のユーザーからの接続は防げるが、`sumi serve` が止まっている間に他のユーザーが待ち受けを差し替えると、偽のサーバーにトークンと出力が渡る。防げるのは 2 つの脅威の片方だけで、一人で使うホストでは何も守らない (上の「対象にするホスト」)。
- **チャレンジレスポンスで相互に確かめる** — 他のユーザーがいるホストでも両方の脅威を防げるが、プロトコル、鍵ファイルの管理、テストが大きく増える。他のユーザーがいるホストには Unix ソケットの構成で足りる。
- **直接接続を先に試し、失敗したら proxy へ** — sandbox の中でエージェントが立てた待ち受けに、`sumi run` がつないでしまう (上の「proxy 経由の接続」)。
- **proxy を使うかを明示するオプション (`--via-proxy` など) を足す** — 規則が決定的になる利点はあるが、hook (sandbox の外) と prefix (sandbox の中) で別の引数を `init` が書き分けることになり、利用者が手で設定するときの誤りも増える。ループバックの proxy の有無で決まる規則なら、同じ引数で両方が正しく動く。
- **TCP の接続だけフレームにし、Unix ソケットは half-close のまま** — nas に触れずに済むが、サーバーとクライアントが 2 つのプロトコルを持ち続けることになる。
- **出力の側に区切りを付け、クライアントが自分で終わりを判断する** — サーバーは入力の終わりが分からないと保持中の末尾を出せないので、入力の終わりを伝える仕組みは結局要る。
- **`--socket` を TCP にも広げる** — MySQL などで Unix ソケット専用の名前として定着しており、`--socket tcp://…` は読み違えられやすい。
