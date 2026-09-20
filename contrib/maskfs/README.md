# maskfs

maskfs は、ディレクトリを FUSE 越しに「シークレットをマスクしたビュー」としてマウントするツールです。nix-agent-sandbox (nas) がコンテナ内のエージェントにワークスペースを見せるために使っていますが、単体でも動きます。

読み取り時にシークレット値を同じ長さの `*` 列に置き換えて返すので、マウントポイント越しの `cat` や `grep` からは本物の値が見えません。この読み取り処理では、元のファイル内容は変更されません。

## インストール

配布バイナリを使う場合、x86_64 Linux では次のようにインストールします。aarch64 Linux では URL のファイル名を `maskfs-aarch64-linux` に替えてください。

```bash
mkdir -p ~/.local/bin
curl -fsSLo ~/.local/bin/maskfs https://github.com/Hogeyama/nix-agent-sandbox/releases/download/maskfs-latest/maskfs-x86_64-linux
chmod +x ~/.local/bin/maskfs
```

この URL は常に最新の maskfs を指すので、更新するときも同じコマンドを実行してください。インストール済みのバージョンは `maskfs --version` で、変更点は [CHANGELOG](CHANGELOG.md) で確認できます。
特定のバージョンに固定したい場合は、URL の `maskfs-latest` を `maskfs-v0.2.0` のようなタグに替えてください（maskfs は nas 本体とは別に `maskfs-v*` タグでリリースしています）。

## 前提条件

- Linux（`/dev/fuse` が使えること）
- `fusermount3` が PATH にあること（fuse3 パッケージ由来、setuid 付き）。アンマウントをホスト側の権限で行うため、maskfs 自身はこれを同梱しません。

## 使い方

シークレットファイルを用意します（改行区切り、空行は無視、各値は4バイト以上・全体で1024件以下）:

```bash
install -m 600 /dev/null secrets.txt
${EDITOR:-vi} secrets.txt
```

マウントします:

```bash
maskfs /path/to/workspace /path/to/mountpoint --secrets-file secrets.txt
```

マウントポイント側でファイルを読むと、シークレットが `*` 列に置き換わって見えます。Ctrl+C でデタッチします。

`--daemon` を付けるとバックグラウンドでマウントし、準備ができた時点で制御を返します:

```bash
maskfs /path/to/workspace /path/to/mountpoint --secrets-file secrets.txt --daemon
maskfs --unmount /path/to/mountpoint
```

その他のオプションは `maskfs --help` を参照してください。書き込みポリシーは既定で `readonly` です。シークレットを含むファイルへの書き込み・切り詰め・削除・名前変更を拒否しますが、それ以外のファイルへの書き込みや新規作成は元のディレクトリに反映されます。`--write-policy passthrough` にすると、シークレットを含むファイルにもそのまま書き込めます。読み取り時のマスクはどちらのポリシーでも有効です。

## リミテーション

- マスクされるのはマウントポイント経由の読み取りだけです。元ディレクトリを直接読めばシークレットは見えます。元ディレクトリへのアクセスを閉じるには nas のような別の隔離機構と組み合わせてください。
- マスク対象はシークレットファイルに列挙した値の完全一致のみです。エンコードや部分一致への変換は行いません。
