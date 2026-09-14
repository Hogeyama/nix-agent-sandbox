# sumi

sumi は、Claude Code にシークレットを読ませないためのツールです。墨消しの墨から取っています。

例えば `config/app.properties` というファイルに `db.password=Tr0ub4dor` というシークレットが入っているとします。
sumi を設定すると、Claude Code には `db.password=*********` と見えるようになります:

<img src="images/demo01.png"/>

マスクは `Read`、`Grep`、`Bash` などの各種ツールが対象です。
ただし、[保護できない経路や値の形式](#リミテーション)もあるため、利用前に確認してください。

## クイックスタート

### インストール

配布バイナリを使う場合、x86_64 Linux では次のようにインストールします。aarch64 Linux では URL のファイル名を `sumi-aarch64-linux` に替えてください。

```bash
mkdir -p ~/.local/bin
curl -fsSLo ~/.local/bin/sumi https://github.com/Hogeyama/nix-agent-sandbox/releases/download/sumi-latest/sumi-x86_64-linux
chmod +x ~/.local/bin/sumi
```

この URL は常に最新の sumi を指すので、更新するときも同じコマンドを実行してください。インストール済みのバージョンは `sumi --version` で、変更点は [CHANGELOG](CHANGELOG.md) で確認できます。
特定のバージョンに固定したい場合は、URL の `sumi-latest` を `sumi-v0.1.0` のようなタグに替えてください（sumi は nas 本体とは別に `sumi-v*` タグでリリースしています）。

### シークレットファイルの作成

任意の場所にパーミッション0600でシークレットファイルを作成します。例:

```
mkdir -p ~/.claude/sumi
[ -e ~/.claude/sumi/secrets.txt ] || install -m 600 /dev/null ~/.claude/sumi/secrets.txt
${EDITOR:-vi} ~/.claude/sumi/secrets.txt
```

シークレットファイルには改行区切りでマスクしたいシークレットを列挙します。


```~/.claude/sumi/secrets.txt
Tr0ub4dor
mYImP0rTaNTpaSS
...
```

> [!NOTE]
> 制限として、各値は 4 バイト以上、全体で 1024 件以下にする必要があります。

### Claude Codeの設定を生成

下記の `sumi init` コマンドを実行すると、`~/.claude/settings.json` にマスク用の hooks と環境変数 `CLAUDE_CODE_SHELL{,_PREFIX}` が追加されます。

```
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt
```

変更前の設定は同ディレクトリ内にバックアップされるようになっています。
設定が完了したら、Claude Code を起動すると、マスクが有効になります。

### 秘密を置き換えたファイルを Bash から読む（オプショナル）

Linux / WSL2 の Claude Code sandbox では、`sumi scan` を使うと、設定ファイルの秘密を身代わりの文字列に置き換えた状態で Bash から読めます。例えば秘密一覧に `Tr0ub4dor` があり、`config/app.properties` が次の内容なら、

```properties
db.password=Tr0ub4dor
```

sandbox 内では `db.password=fake_value_<uuid>` のように読めます。値の置き換えは Claude Code が行い、元のファイルは変更しません。macOS ではファイル mask が読み取り禁止になるため、この使い方の対象外です。

```sh
cd path/to/project
sumi scan --agent claude --secrets-file ~/.claude/sumi/secrets.txt
```

既定ではカレントディレクトリを検査し、絶対パスと抽出ルールをユーザー設定の `sandbox.credentials.files` に `mode: "mask"` で登録します。走査対象は `--root DIR` で変更できます。書き込み先は `$CLAUDE_CONFIG_DIR/settings.json`、環境変数がなければ `~/.claude/settings.json` です。`--settings /path/to/settings.json` で別ファイルに書く場合は、Claude Code もそのファイルを `--settings` で読み込んでください。プロジェクト設定の mask は Claude Code に無視されるため、ユーザー設定以外の `.claude` ディレクトリへの書き込みは拒否します。sandbox の有効化（`sandbox.enabled: true`）も必要です。

登録しただけでは、本物の値を使う認証はできません。新規エントリは `injectHosts: []` なので、送信時にも身代わりのままで、Claude Code の起動時に empty injectHosts の警告が出ます。本物を送る必要がある場合は、利用者が `injectHosts` と `sandbox.network.allowedDomains` に送信先を指定し、HTTPS では `sandbox.network.tlsTerminate` も設定してください。scan は送信先を追加せず、この書き込み先以外の設定スコープも確認しません。

実行結果は stderr に表示されます。

* `mask <path>`：登録または更新しました。
* `skip <path>: <理由>`：登録を見送りました。パスに glob 文字がある、8 MiB を超える、不正な UTF-8、抽出できない形式、一部の秘密を隠せない、既存のユーザー設定と競合する、といった理由があります。新規ファイルの skip だけなら終了コードは0です。
* `unmask <path>`：ファイルが消えた、秘密がなくなった、またはルールを再生成できなくなったため、所有する設定を削除しました。再生成できない場合は `was masked, now <理由>` と表示し、終了コード1を返します。この場合、そのファイルは秘密を含むまま読めるため、内容や設定を確認してください。

設定・所有記録へ書くパスや表示するパスに秘密一覧の値またはその展開パターンが含まれる場合は、何も書かず終了コード1で中止します。

ファイルの内容・配置や秘密一覧を変更したら再実行してください。所有記録は設定ファイルに隣接する `settings.sumi-scan.json` などに保存し、sumi が登録した分だけを更新・削除します。利用者が変更した `injectHosts` やその他の独自フィールドは維持し、手で書いた別エントリ、同じパスの重複、同じ絶対パスの `denyRead` との競合は残して skip にします。読めないファイル・ディレクトリは警告して終了コード1とし、確認できなかった設定は残します。設定の変更時には原本をバックアップし、変更のない再実行では書き込みません。

抽出した値はその全体が置き換わります。例えば秘密を含む URL は URL 全体が身代わりになるため、値の構造を使う処理が動かなくなる場合があります。抽出ルールでは `maskDuplicates: true` により、同じファイル内の同じ値のコピーも置き換わります。短い値・一般的な値なら別の箇所にも影響します。秘密の値一つだけのファイルは全体をマスクします。

`.git`、シンボリックリンク、通常ファイル以外と秘密一覧ファイルは走査対象から除きます。sumi 自体が sandbox 内で秘密一覧を読む必要があるため、この機能では Bash がその一覧を加工して読み出す経路を塞げません。秘密一覧はプロジェクト外に置いてください。

## リミテーション

sumi は下記の限界があります。これが許容できない場合はより強力なシークレット保護を提供する nix-agent-sandbox 本体の利用を検討してみてください。

### マスクの代わりに拒否となるケース

以下の場合、マスクの代わりに拒否されます。

* プロンプト内で `@config/app.properties` のようにシークレットを含むファイルを読もうとしたとき
  <img src="images/limitation-at.png" />
* `@` 指定のパスを解決できず、内容を確認できなかったとき
  * 拡張子の長さや有無にかかわらず拒否します

### マスクも拒否もできないケース（すり抜けてしまうケース）

* `CLAUDE.md`など hook が使われない経路で読まれる情報にシークレットが含まれるとき
* シークレットがエンコードされたとき
  * 単純なbase64やquoteには対応していますが、2重でbase64
* hook が無効化されたとき
  * Claude Codeが入れ子で `claude --bare` や `claude --settings '{"disableAllHooks":true}'` を実行するケースや
  * Claude Codeが `settings.json` を編集するケース
* HTTP MCPがシークレットを出力しながら失敗したとき

## sumi を外す

Claude Code を終了し、`init` が更新した設定ファイルを編集します。通常は `~/.claude/settings.json`、`CLAUDE_CONFIG_DIR` を設定していた場合はそのディレクトリの `settings.json` です。`--settings` を指定していた場合は指定したファイルを編集します。`hooks` 内の `PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit` から、sumi を実行する hook を削除してください。

`env` 内の `CLAUDE_CODE_SHELL_PREFIX`、`CLAUDE_CODE_SHELL` も削除します。導入前に値が設定されていた項目は、バックアップにある元の値へ戻してください。
