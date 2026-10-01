# sumi serve の TCP 待ち受けと `--server` 実装計画

spec: `docs/superpowers/specs/2026-10-02-sumi-serve-tcp-design.md`

## Global Constraints

- 実装者・レビュアーは着手前に spec を全部読む。
- `security-constraints` スキル (`~/.claude/skills/security-constraints/SKILL.md`) と `test-policy` スキル (`.claude/skills/test-policy/SKILL.md`) を読む。nas 自身は Unix ソケットだけを使い続ける (N1)。
- serve.zig の「出力の不変条件」を守る: ストリーム由来のバイトを stdout/stderr に書かない。sumi の hook と run も、原因ごとの詳細を stderr に出さない (`masker.UNAVAILABLE_REASON` の文言は変えない)。
- fail-closed を崩さない。TCP や proxy の失敗は、今の「ブローカーに接続できない」と同じ経路 (`RelayConnectFailed` → hook は伏せて止める、run は 121) に入れる。
- コメントは周囲と同じく日本語で、「なぜ」を書く。
- Zig 0.15.2。`zig fmt` を通す。
- コミットは `git-commit` スキルに従う。plan / spec を参照する文言をコミットメッセージに書かない。
- 各タスクの確認コマンドはリポジトリのルートで実行する。

## nas が同梱する sumi

`flake.nix` は `contrib/sumi` を同じソースからビルドし、`$out/sumi/` にコピーする (`cp ${sumi}/bin/sumi $out/sumi/`)。nas が別のバージョンの sumi を取ってくることはないので、`--socket` の削除と nas 側の置き換えは同じブランチでそろえればよい (Task 6)。

## Task 1: ADDR の解釈 (`lib/process-supervisor/address.zig`)

新規ファイル。`supervise.zig` から `pub const address = @import("address.zig");` で公開し、`test {}` で参照してテストルートに含める (serve.zig と同じやり方)。

```zig
pub const Address = union(enum) {
    /// Unix ソケットのパス (相対パスも可)。
    unix: []const u8,
    /// ループバックの TCP。
    tcp: std.net.Address,
};
pub const ParseError = error{ InvalidAddress, SocketPathTooLong };
pub fn parse(text: []const u8) ParseError!Address
```

- `unix://` で始まれば、その後ろを Unix のパスとする。後ろが絶対パス (`/` 始まり) でなければ `InvalidAddress`。
- `tcp://` で始まれば、`127.0.0.1:PORT` か `[::1]:PORT` だけを受け付ける。それ以外のホスト (`localhost`、他の IP、ホスト名)、ポートの欠落、`0`、65535 超、数字以外は `InvalidAddress`。
- それ以外で `://` を含むもの (未知のスキーム) は `InvalidAddress`。
- それ以外は素の Unix パス。空なら `InvalidAddress`。
- Unix パスが 107 バイトを越えれば `SocketPathTooLong` (serve.zig の `MAX_SOCKET_PATH` と同じ値。定数はこのファイルへ移し、serve.zig と relay.zig はこれを参照する)。

テスト: spec の「テスト」の `address.zig` の項目すべて。

確認: `bun run test:process-supervisor-unit`

## Task 2: serve が TCP で待ち受ける (`serve.zig`)

- `run(gpa, secrets, listen: address.Address)` に変える。`validateSocketPath` は `address.parse` に吸収されるので削除し、呼び出し元を直す。
- Unix は今の `bindListener` のまま。
- TCP は `socket(AF_INET/AF_INET6, SOCK_STREAM|CLOEXEC|NONBLOCK)`、`SO_REUSEADDR`、bind、listen。`SO_REUSEADDR` は、再起動直後に TIME_WAIT で bind が失敗しないようにするため。
- accept 以降のループは変えない (fd の種類に依存していないことを読んで確かめる)。
- ファイル冒頭の説明を「Unix domain socket か ループバックの TCP」に直す。TCP は一人で使うホスト専用である理由を一文添える (spec の「対象にするホスト」)。
- 呼び出し元: `src/mask-filter/mask_filter.zig` は `--serve PATH` を `.{ .unix = PATH }` で渡す (パス長の検査が今と同じに働くこと)。`contrib/sumi/main.zig` の `runServe` は Task 5 で直すので、ここではコンパイルが通る最小の変更 (`.{ .unix = parsed.listen }` と、長さ検査を `address.parse` に置き換え) に留める。

テスト (serve.zig): テスト内で `127.0.0.1` のポートを 1 つ確保し (port 0 で bind して番号を読み、閉じてから使う)、別スレッドで `run` を起動し、接続して既存と同じマスクが返ることを確かめる。`run` は返らないので、テストは既存のテストと同じく、スレッドを detach したまま終わってよいかを既存のテスト (`relay.zig` の TestBroker 等) を見て判断する。

確認: `bun run test:process-supervisor-unit`、`bun run test:mask-filter-unit`、`bun run test:sumi-unit`

## Task 3: relay が TCP と proxy でつなぐ (`relay.zig`、`supervise.zig`)

- `Relay.connect(addr: address.Address, proxy: ?[]const u8)` に変える。`proxy` は呼び出し元が環境変数から選んで渡す (テストで環境変数を書き換えなくて済むように)。
- `pub fn proxyFromEnv() ?[]const u8`: `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy` の順に最初に空でない値を返す。
- Unix は今のまま (proxy は無視)。
- TCP:
  - `proxy` が `http://` で始まり、ホストが `127.0.0.1`、`[::1]`、`localhost` のどれかなら、その proxy へ TCP 接続し `CONNECT 127.0.0.1:PORT HTTP/1.1` (IPv6 なら `[::1]:PORT`) と `Host:` を送る。URL にユーザー情報があれば `Proxy-Authorization: Basic base64(user:pass)` を付ける。応答ヘッダを `\r\n\r\n` まで、上限 8 KiB まで読み、状態行が `HTTP/1.0 200` か `HTTP/1.1 200` で始まらなければ `RelayConnectFailed`。ヘッダの後ろに余分なバイトが来ていたら `RelayConnectFailed` (サーバーは先に何も送らないので、来るのは異常)。
  - それ以外は ADDR へ直接 TCP 接続する。
  - フォールバックはしない (spec の「なぜ『直接 → 失敗したら proxy』としないか」)。
  - 接続は今と同じく、ブロッキングで済ませてから非ブロッキングにする。CONNECT の読み書きもブロッキングで行い、5 秒の受信タイムアウト (`SO_RCVTIMEO`) を付ける。
  - 再試行 (`CONNECT_ATTEMPTS`) は直接接続にも proxy 接続にも今と同じく適用する。proxy の 403 は再試行しない。
- `maskOnce(gpa, addr, proxy, input)` と `supervise.run(..., addr, proxy, ...)` を合わせて変える。
- 呼び出し元: nas-mask-filter の `--supervise --socket` は `.{ .unix = path }` と `null` を渡す (nas は proxy を使わない)。sumi の呼び出し元は Task 5 で直すので、ここではコンパイルが通る最小の変更に留める。

テスト (relay.zig): TCP の直接接続でマスクが往復する。テスト内に最小の CONNECT proxy (スレッド) を立て、proxy 経由で往復する。403 で `RelayConnectFailed`。ヘッダが 8 KiB を越えると `RelayConnectFailed`。ユーザー情報付きの URL で `Proxy-Authorization` が正しく付く。ループバック以外の proxy (`http://10.0.0.1:3128`) と `https://` の proxy は無視して直接つなぐ。

確認: `bun run test:process-supervisor-unit`、`bun run test:mask-filter-unit`

## Task 4: 入力の終わりをフレームで伝える (`serve.zig`、`relay.zig`、`supervise.zig`)

srt の proxy は half-close を通さない (spec の「ブローカーのプロトコル」の実測)。Unix ソケットと TCP の両方で、入力をフレームで送るプロトコルに替える。spec の「新しいプロトコル」を正とする。

- フレーム: `[u32 ビッグエンディアンの長さ][バイト列]`。長さは 1..`relay.CHUNK_SIZE` (64 KiB)。長さ 0 が入力の終わり。上限の定数はクライアントとサーバーで同じものを使う (置き場所は `address.zig` と同じく両者が参照できる場所にする)。
- serve.zig: 接続ごとにフレームの読み取り状態 (ヘッダの残りバイト数、本文の残りバイト数、終わりを受け取ったか) を持つ。本文を MaskStream に渡す。終わりのフレームで今の EOF と同じ処理 (`stream.finish`) をする。次の場合は末尾を送らずに閉じる: 長さが上限越え、終わりのフレームの前に EOF。終わりのフレームを読んだ後はその接続から読まず (POLLIN を待たない)、後から届いたバイトは捨て、末尾を送り切ったら閉じる。終わりのフレームと余分なバイトが 1 回の read で同時に届いた場合も、余分なバイトは MaskStream に渡さない。MaskStream を最初の本文のバイトで初期化するという今の方針 (accept しただけの接続にメモリを確保しない) を保つ。シークレットがフレームの境界をまたいでもマスクされること。
- relay.zig: `queueWrite` はバイト列をフレームに包んでキューに積む (`CHUNK_SIZE` を越えるときは分ける)。`halfClose` を「終わりのフレームを積む」に替える (名前も実態に合わせる)。`shutdown(SHUT_WR)` は使わない。`Relay` に送った本文の合計バイト数と受け取ったバイト数を持たせ、サーバーが閉じたとき「終わりのフレームを送り切っていない」か「両者が一致しない」なら失敗にする判定を `Relay` に置く。`maskOnce` の今の長さの照合はこれに置き換え、`supervise.run` もこの判定を使う (子が 0 で終わっても、判定が失敗なら 121)。理由は spec の「応答が最後まで届いたかの判定」。
- supervise.zig: `halfClose` を呼んでいる箇所を新しい関数に替える。ファイル冒頭とコメントの half-close の説明を直す。
- serve.zig と relay.zig の冒頭の「プロトコル」の説明を新しいものに書き換え、half-close をやめた理由 (srt の proxy) を一文添える。
- プロトコルを直接話すテストを合わせる: relay.zig のテスト用ブローカー、`contrib/sumi/masker.zig` の `TestBroker`、`src/stages/maskfs/mask_filter_integration_test.ts`、`src/stages/launch/integration_test.ts` の偽 sumi。ほかに `rg -n 'SHUT_WR|shutdown\(' lib contrib/sumi src tests` で見つかる、ブローカーのプロトコルを話すもの (hostexec など無関係なものは除く)。
- 同じタスクで、Task 3 のレビューの警告 2 件を直す:
  - proxy 経由の接続で、403 以外の 200 でない応答 (502 など)、早すぎる close、受信タイムアウトでも、直接接続と同じ回数・間隔で再試行する。403 だけは再試行しない (`relay.zig` の proxy 接続)。
  - URL のユーザー情報に `:` が無い (`http://user@127.0.0.1:P`) ときは `user:` を base64 にする (RFC 7617)。

テスト: spec の「テスト」の serve.zig と relay.zig / supervise.zig の項目。特に「終わりのフレームを受け取った後に末尾を返さず閉じるテスト用ブローカー」で、`maskOnce` と `supervise.run` (子は 0 で終わる) の両方が失敗することを確かめる。再試行とユーザー情報の 2 件にもテストを足す。

確認: `bun run test:process-supervisor-unit`、`bun run test:mask-filter-unit`、`bun run test:sumi`、`bun test src/stages/maskfs/mask_filter_integration_test.ts`、`bun test src/stages/launch/integration_test.ts` (Docker が要るものは skip されうるので skip の件数を報告する)。

## Task 5: sumi の CLI (`--server`、`serve --listen ADDR`)

- `masker.zig`: `Source.socket` を `Source.server: address.Address` に、`SourceOption` の `--socket` を `--server` に替える。`--server` の値は `address.parse` し、不正なら usage エラー (終了コード 2)。`Masker` の接続は `relay.proxyFromEnv()` を渡す。
- `main.zig`: `runServe` の `--listen` を `address.parse` で解釈する。`makeSocketDir` は Unix のときだけ呼ぶ。usage 文と冒頭コメントの `--socket SOCKET` を `--server ADDR` に、`--listen SOCKET` を `--listen ADDR` に直す。`run` の経路も `--server` に替える。
- `claude/init.zig` と `agent_hooks.zig` ほか: `--socket` を書き出している箇所を `--server` に替える。既存の settings に古い `--socket` の sumi の hook / prefix があった場合の扱いは、今 `--secrets-file` から `--socket` へ切り替えたときと同じ扱い (sumi の hook として認識して置き換える) になるかを読んで確かめ、ならなければ認識に `--socket` も含める。
- `contrib/sumi/tests/run-tests.sh`: `--socket` を `--server` に替える。追加: TCP の `sumi serve` に対して `run` と hook がマスクできる。python で最小の CONNECT proxy を立て、`HTTP_PROXY=http://127.0.0.1:PROXYPORT` で `run` が通る。サーバーが止まっていると `run` は 121、hook は伏せて止める。`--socket` が usage エラー (2) になる。ポートは空いている番号を python で選ぶ。
- `contrib/sumi/tests/manual-validation.md` に `--socket` があれば直す。

確認: `bun run test:sumi`

## Task 6: nas 側の `--socket` を `--server` に替える

- `src/stages/maskfs/mask_filter_service.ts` の `buildClaudeHookSettings`。
- `src/stages/agent_hooks/settings.ts` (codex の hook スクリプトと copilot の設定)。
- `src/docker/embed/entrypoint.sh` の `exec "$nas_mask_filter_path" run --socket ...`。
- テスト: `src/stages/maskfs/mask_filter_service_test.ts`、`src/stages/agent_hooks/*_test.ts`、`src/stages/launch/integration_test.ts` の偽 sumi (`argv[0] == "--socket"`)、その他 `rg -- '--socket'` で見つかる nas のテストと fixture。nas-mask-filter 自身の `--supervise --socket` は変えない。

確認: `bun run test:unit`、`bun run test:nas-integration` の該当ファイル (`bun test src/stages/maskfs src/stages/agent_hooks src/stages/launch`。Docker が要るものは skip されうるので、skip の件数を報告する)。

## Task 7: 文書

- `contrib/sumi/CHANGELOG.md` の Unreleased:
  - Added: `sumi serve --listen` が `tcp://127.0.0.1:PORT` を受け付け、Claude Code の Bash sandbox (srt) の中から proxy 経由で使えること。一人で使うホスト向けであること。既存の `sumi serve` の行と矛盾しないように直す。
  - Changed: `--socket PATH` を削除し `--server ADDR` に置き換えたこと (`--socket PATH` は `--server PATH`)。
- `lib/README.md`: process-supervisor が持つものに ADDR の解釈と TCP を足す。
- `contrib/sumi/README.md` はユーザーが更新済み。`--socket` が残っていないことと、`#DevContainerで使う` のリンクが GitHub のアンカー (`#dev-container-で使う`) と合っていないことを、修正せず報告だけする (README はユーザーの作業中のファイルなのでコミットに含めない)。

確認: `git diff` を読む。

## 最後に

- `bun run test:sumi`、`bun run test:process-supervisor-unit`、`bun run test:mask-filter-unit`、`bun run test:unit` を流す。その後、CLAUDE.md の終了時の検証として、リポジトリのルートで `bun run test` と `hostexec bun run test` を順に 1 回ずつ実行する。1 つ目が失敗しても 2 つ目を実行し、利用者に改めて確認はしない。両環境の結果と skip を別々に報告する。
- 手動の検証 (ホストで本物の `sumi serve --listen tcp://…` と Claude Code の sandbox) は `.local/srt-tcp-probe/claude.sh` を元に別に行い、`contrib/sumi/tests/manual-validation.md` に記録する。これは利用者の承認 (hostexec) が要るので、実装の後に利用者と行う。
