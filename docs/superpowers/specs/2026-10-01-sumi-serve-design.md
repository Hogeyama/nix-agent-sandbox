# sumi serve: secrets ファイルを読むマスクブローカー

## 目的

sumi の hook と `run` は `--socket SOCKET` を受け取り、秘密一覧を読まずにブローカーへマスクを問い合わせられる。
ところがブローカーは `nas-mask-filter --serve` しかなく、これは nas 専用のバイナリ形式のフレーム (`NAS_MASK_SECRETS_FILE`) しか読まない。
nas を使わない利用者は `--socket` を使えない。

`sumi serve` を足し、sumi の secrets ファイル (1 行 1 値のテキスト) をホスト側で読んで同じプロトコルで待ち受ける。
想定する使い方は Dev Container の中の Claude Code である。

```
# ホスト
sumi serve --secrets-file ~/.claude/sumi/secrets.txt --listen "$XDG_RUNTIME_DIR/sumi/mask.sock"

# devcontainer.json で "$XDG_RUNTIME_DIR/sumi" を /run/sumi に読み取り専用 (readonly) で bind mount し、コンテナ内で
sumi init --agent claude --socket /run/sumi/mask.sock
```

secrets ファイルはコンテナに mount しない。エージェントから届くのはソケットだけになる。

## CLI

```
sumi serve --secrets-file FILE --listen SOCK
```

- `--secrets-file` と `--listen` はどちらも必須で、各 1 回だけ受け付ける。順序は問わない。
- `--socket` は受け付けない。ブローカー自身が一覧を持つ必要があるからである。
- 未知の引数、値の欠落、重複は usage エラー (終了コード 2)。

## 挙動

1. `serve.validateSocketPath` でパス長を検査する。空か 107 バイトを越えていれば終了コード 2。
2. `secrets.load(FILE)` で一覧を読む。他のサブコマンドと同じく、base64 の行は復号値も展開する。
   読めなければ `secrets.describe` の理由を stderr に書き、bind する前に終了コード 1 で終わる。
3. `serve.run(allocator, list, SOCK)` に入る。kill されるまで返らない。
   bind の失敗などで返ったエラーは、定数の文言で stderr に書いて終了コード 1。

次の点は serve.zig の既存の挙動をそのまま使い、sumi 側で変えない。

- 起動時に古いソケットファイルを unlink する。
- umask と chmod でソケットの権限を 0600 にする。
- 接続数、接続ごとの未送信バイト数、EMFILE 時のバックオフに上限を設ける。
- ストリーム由来のバイトを stdout/stderr に書かない。sumi 側の診断も、定数の文言と利用者が渡したパスだけにする。

secrets ファイルの読み直しは持たない。変更したら再起動する。

## コード構成

| 変更 | 内容 |
|---|---|
| `src/mask-filter/serve.zig` → `lib/process-supervisor/serve.zig` | `git mv` で移す。中身は変えない |
| `lib/process-supervisor/supervise.zig` | relay と同じく `pub const serve = @import("serve.zig")` で公開し、`test {}` から参照してテストルートに含める |
| `src/mask-filter/mask_filter.zig` | `@import("serve.zig")` を `supervise.serve` に替え、serve のテストを参照する `test {}` を外す |
| `contrib/sumi/main.zig` | `serve` の分岐、引数の解釈、usage、冒頭コメント |
| `lib/README.md` | 所有表と「サーバーは src/mask-filter に残す」の記述を更新する |
| `contrib/sumi/README.md` | `--socket` の節に `sumi serve` と Dev Container の手順を書く |
| `contrib/sumi/CHANGELOG.md` | Unreleased に追記する |

serve.zig は `masking` の `stream` だけに依存し、製品のソースを import しない。
`lib/` の「製品のソースを import しない」という規則に収まる。
relay (クライアント) と serve (サーバー) が同じライブラリに入るので、ブローカーのプロトコルの両端を 1 か所で持つことになる。

serve を `supervise` モジュールの一部にするので、どの `build.zig` も変えない。
Zig 0.15 では 1 つのファイルは 1 つのモジュールにしか属せないため、serve.zig を別のモジュールのルートにしつつ supervise.zig から import する形は取れない。

Nix の sumi と nas-mask-filter の fileset は、すでに `lib/process-supervisor` を含む。
checkPhase も `lib/process-supervisor` の `zig build test` を実行しているので、移したテストは Nix のビルドでも走る。

## README に書く Dev Container の注意

- ディレクトリは readonly で mount する。コンテナ内のエージェントが mask.sock を消して自前の待ち受けに差し替えるのを防ぐ。読み取り専用 mount 上のソケットへの connect はできる。
- ソケットファイルではなくディレクトリを mount する。serve を再起動するとソケットが作り直され、ファイル単体の bind mount は古い inode を指したままになる。
- ソケットは 0600 なので、コンテナのユーザーの UID をホストの serve と合わせる。
- secrets ファイルを置いたディレクトリはコンテナに mount しない。

## テスト

- unit (`contrib/sumi/main.zig`): `serve` の引数の解釈。両方指定 (順序違いも)、片方の欠落、値の欠落、重複、`--socket` の指定、未知の引数。
- black-box (`contrib/sumi/tests/run-tests.sh`): 一時ディレクトリに `sumi serve` を起動し、ソケットが現れるまで待ってから次を確かめる。trap で serve を止める。
  - `sumi run --socket SOCK` の出力で、secrets ファイルの値が伏せられる。
  - `sumi hook --agent claude post-tool --socket SOCK` が値を伏せた `updatedToolOutput` を返す。
  - base64 で書いた行の復号値も伏せられる (sumi のテキスト形式で読んでいることの確認)。
  - 読めない secrets ファイルを渡すと、ソケットを作らずに非ゼロで終わる。
- 移したテスト: `bun run test:process-supervisor-unit` の `--summary all` で、serve.zig の 4 件 (`validateSocketPath`) を含めてテスト数が移動前より 4 件増えることを確かめる。`bun run test:mask-filter-unit` は同じ 4 件が減る。
- 既存の `src/stages/maskfs/mask_filter_integration_test.ts` (`nas-mask-filter --serve` を起動する) が変わらず通る。

## 範囲外

- srt (sandbox-runtime) との組み合わせ。srt は Linux で `socket(AF_UNIX)` を seccomp で塞ぐので、srt の中の hook はソケットに接続できない。代わりの経路の調査結果は `docs/superpowers/probes/srt-fd-inherit/README.md` にある。
- nas-mask-filter の、本番では使われていない `--supervise` の削除。
- secrets ファイルの読み直し、ソケットのパスの自動決定、デーモン化。

## Why — なぜこのアプローチを選んだか

serve.zig の `run(gpa, secrets, sock_path)` は値の一覧を受け取るだけで、ファイル形式に依存しない。
nas-mask-filter と sumi の違いはファイル形式とその読み方だけで、待ち受けとマスクの処理は同じでよい。
serve.zig を共有ライブラリへ移せば、各製品は自分の形式で一覧を読んで `run` を呼ぶだけになり、重複は引数の解釈の数十行で済む。
接続数の上限や出力の不変条件など、エージェントから到達できる攻撃面に関わる部分を 1 か所で保守できる。
nas 側の挙動は変わらない。

名前は `serve` にした。sumi と nas-mask-filter では「supervise」がすでに中継側 (`run` の子の出力をブローカーへ送る側) を指している。
ブローカーを `supervise` と呼ぶと、同じ単語が逆の役割を指すことになる。

## Why Not — なぜ他の案を選ばなかったか

- **案 B: nas-mask-filter を廃止して sumi に一本化する** — nas が sumi のテキスト形式で一覧を書き出すと、UTF-8 でない値と 4 バイト未満の値を扱えなくなる。base64 の自動展開で、伏せる範囲も変わる。sumi にフレーム形式を読むオプションを足すと、別々にリリースしている sumi の公開 CLI に nas 専用の都合が入る。
- **案 C: sumi に serve を別に実装する** — 接続の多重化、資源上限、出力の不変条件を 2 か所で保守することになる。
- **srt で使う経路 1: `allowAllUnixSockets: true`** — srt の中から、見えるすべての Unix ソケットに接続できるようになる。docker.sock に届けば `docker run -v` で secrets ファイルを読め、ユーザーの D-Bus セッションバスに届けば `systemd-run --user` でサンドボックスの外から読める。一覧を守るために、一覧を渡すより大きな穴を開けることになる。
- **srt で使う経路 2: 制御用 fd の継承 + `SCM_RIGHTS`** — node の `child_process.spawn` と Bun の spawn は、子を起動するときに stdio 以外の fd を閉じる。srt は node で bwrap を起動し、claude は Bun で hook を起動するので、2 か所で fd が落ちる (プローブで確認)。
- **srt で使う経路 3: socketpair の DGRAM ソケットをパスへ connect し直す** — srt の seccomp は `socket(AF_UNIX)` だけを塞ぎ、`socketpair` を塞がない。この組み合わせでパス上の DGRAM ソケットに届く。ただし、これは srt の制限の穴を突く方法で、塞がれれば動かなくなる。
