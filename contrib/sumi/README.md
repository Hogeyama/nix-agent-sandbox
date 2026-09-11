# sumi

sumi は、Claude Code の成功したツール出力と Bash の出力（成功・失敗の両方）に含まれる登録済みの値を、同じ長さの `*` に置き換える単一バイナリです。たとえば `config/app.properties` の `db.password=Tr0ub4dor` は、`db.password=*********` と見え、周囲の出力はそのまま読めます。

保護対象の値を含む `@` 添付は拒否します。読み取るファイルや Git 履歴は書き換えません。[保護できない経路や値の形式](#守らないもの)もあるため、導入前に確認してください。

Linux（x86_64 / aarch64）、`bash`、Claude Code 2.1.266 以降が必要です。Claude Code 2.1.268 で動作を確認しています。nas や Nix のインストールは不要です。

## インストール

x86_64 Linux では次のようにインストールします。aarch64 Linux では URL のファイル名を `sumi-aarch64-linux` に替えてください。途中でエディタが開いたら、隠したい値を1行ずつ記入して保存します。

`init` は設定先の `disableAllHooks` を `false` にします。全 hook を無効にしていた場合、保存済みの他の hook も再び動く可能性があります。

```bash
mkdir -p ~/.local/bin
curl -fsSLo ~/.local/bin/sumi \
  https://github.com/Hogeyama/nix-agent-sandbox/releases/latest/download/sumi-x86_64-linux
chmod +x ~/.local/bin/sumi

mkdir -p ~/.claude/sumi
if [ ! -e ~/.claude/sumi/secrets.txt ]; then
  install -m 600 /dev/null ~/.claude/sumi/secrets.txt
fi
${EDITOR:-vi} ~/.claude/sumi/secrets.txt

~/.local/bin/sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt
```

secrets ファイルには、隠したい**値だけ**を書きます。たとえば `db.password=Tr0ub4dor` の値を隠すなら、`Tr0ub4dor` と記入します。古い値が Git 履歴に残っている場合は、その値も追加してください。

secrets ファイルは 1 行 1 値の UTF-8 テキストです。空行は無視しますが、LF 以外の空白は値の一部です。各値は 4 バイト以上、全体で 1024 件以下にし、通常は mode `0600` にします。sumi はこのファイルを直接読み、中間ファイルを作りません。

`init` は Claude Code の設定に hook（ツールの実行前後などに sumi を呼び出す設定）を追加し、自己診断します。既存の hook は残し、変更前の設定をバックアップします。`self-check passed` を確認したら、Claude Code を新しく起動してください。

## 導入後の動作

| 操作 | sumi の動作 |
| --- | --- |
| Read・Grep・MCP などの成功したツール出力 | 登録した値を `*` に置き換える |
| Bash で `cat` や `git show` を実行する | 成功・失敗にかかわらず出力をマスクし、終了コードを保つ |
| 保護対象の値を含むファイルを `@` で添付する | プロンプトを拒否する |
| Bash 以外のツールが失敗する | 失敗本文はマスクできず、登録した値が含まれていればモデルへ届く |

### 添付が拒否されたとき

`@` 添付は内容をマスクできないため、保護対象の値があればプロンプトごと拒否します。内容が必要なら、添付を外し、Claude に Read などのツールで必要な箇所を読むよう依頼してください。

Claude Code の `--add-dir` や `permissions.additionalDirectories` で追加したディレクトリは、sumi にも登録します。対象をすべて `--root` で指定して `init` を再実行してください。

```bash
~/.local/bin/sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt \
  --root /path/to/additional-directory
```

`--root` は検査する場所を追加する指定です。登録後も、保護対象の値を含む添付は拒否されます。複数のディレクトリは `--root` を繰り返して指定できます。

存在を確認できない `@` トークンは、`/` を含むか、英字で始まる 1～4 文字の拡張子を持つ場合に拒否します。たとえば `@./gone.properties` は拒否しますが、スラッシュのない `@gone.properties` はこの判定だけでは拒否しません。MCP リソースの `@server:scheme://path` も検査できないため拒否します。

### Bash の権限確認

Bash コマンドは、出力をマスクするために `sumi run …` へ書き換えられます。権限確認はこの書き換え後のコマンドに対して行われるため、既存の `Bash(cat:*)` などの許可があっても、改めて承認を求められることがあります。

承認画面で `sumi run *` を恒久許可すると、個々の元コマンドではなくラッパー全体を許可することになります。個別に確認したい場合は、今回だけの許可を選んでください。auto mode では、Claude Code の判定により承認画面が出ないこともあります。

## 守らないもの

- **変換された値。** 一致判定はバイト列の完全一致です。`base64` や `xxd` を通した出力、UTF-8 として不正な値、JSON の数値・真偽値として現れる値は素通ります。
- **hook を通らない実行。** `/dev/tty` への直接書き込み、`bash` を経由しないプロセス起動、Bash から入れ子で起動した `claude --bare` や `--settings '{"disableAllHooks":true}'` は対象外です。
- **hook が起動できない状態。** バイナリの移動・削除や、Claude Code 側の 20 秒の timeout を超えた場合は、マスクされていない出力がモデルへ届くことがあります。secrets ファイルの不備は sumi が検出して処理を止めます。
- **Bash 以外のツールの失敗本文。** エラーメッセージに保護対象の値が含まれていても、報告だけになり、その値はモデルへ届きます。
- **走査上限の外。** `@` 添付は 1 ファイルの先頭 32 MiB、ディレクトリ直下 100 ファイル、名前による探索は深さ 6・50 件まで検査します。15 秒以内に確認できない添付は拒否します。
- **エージェント自身による無効化。** 通常構成では Claude Code と sumi が同じ UID で動くため、エージェントは設定を書き換えられます。
- **列挙されていない値。** 退役した値が履歴に残る場合も secrets ファイルへ列挙する必要があります。

sumi は、列挙した値を上の表にある経路で隠します。IDE が共有する選択範囲、自動で読み込まれる `CLAUDE.md`、SessionStart hook の `additionalContext`、スラッシュコマンドの `!` 展開など、表にない経路は対象外です。Claude Code の更新で新しい経路や出力形式が加わりうるため、更新時に経路と実測結果を見直す運用が必要です。

## 固める構成

エージェントによる設定の書き換えも防ぎたい場合は、バイナリ、secrets ファイル、管理者設定を root 管理にします。

```bash
sudo install -d -o root -g root -m 0755 /opt/sumi
sudo install -o root -g root -m 0755 ~/.local/bin/sumi /opt/sumi/sumi
sudo install -o root -g root -m 0640 ~/.claude/sumi/secrets.txt /opt/sumi/secrets.txt
sudo chgrp "$(id -gn)" /opt/sumi/secrets.txt
sudo install -d -o root -g root -m 0755 /etc/claude-code
sudo /opt/sumi/sumi init --agent claude --secrets-file /opt/sumi/secrets.txt --settings /etc/claude-code/managed-settings.json
```

管理者設定は下位のユーザー設定やプロジェクト設定から上書きされず、ユーザー設定の `disableAllHooks` でも無効化できません。ただし Claude Code の `--bare` を禁止することはできません。

## Bash のラップを外す

Bash の元コマンドに対する既存の権限ルールを優先したい場合は、設定ファイルの `hooks.PreToolUse` で `matcher` が `Bash` の要素を開き、その `hooks` 配列から sumi の pre-bash hook だけをエディタで削除します。対象は `command` をシェルの単語として読んだとき、引用符を外した先頭語の basename が `sumi` で、続く語が `hook --agent claude pre-bash` となる entry です。たとえば `/opt/sumi/sumi hook --agent claude pre-bash ...` と `'/path with space/sumi' hook --agent claude pre-bash ...` はどちらも対象です。削除後にその `hooks` 配列が空になった場合だけ、空の `Bash` matcher 要素も削除します。同じ配列にある他の hook や、PostToolUse、PostToolUseFailure、UserPromptSubmit の sumi hook は残してください。編集前に設定ファイルをコピーしておくと戻せます。

PreToolUse hook を外すと、失敗した Bash コマンドの出力は PostToolUse を通らず、保護対象の値もそのまま届きます。再び同じ `sumi init` コマンドを実行すると PreToolUse hook が戻ります。

## 更新が必要になるとき

値をローテーションしたときや、古い値が Git 履歴などに残るときは、新旧の値を secrets ファイルへ追加してください。次の hook 呼び出しから反映されます。

sumi バイナリを別の場所へ移した場合、設定には以前の絶対パスが残ります。新しい場所のバイナリで `init` を再実行してください。

## sumi を外す

Claude Code を終了し、`init` で指定した設定ファイル（通常は `~/.claude/settings.json`）を編集します。`hooks` 内の `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit` から、sumi を実行する hook を削除してください。

対象は、`command` の先頭が sumi の実行ファイルで、続く語が `hook --agent claude` となるものです。パスが引用符で囲まれている場合もあります。同じ配列の他の hook は残し、hook 配列が空になったグループだけを削除します。

手動で hook を削除する場合は、`disableAllHooks` もバックアップを確認して導入前の値へ戻します。元の設定に項目がなければ、その項目を削除します。

導入後に他の設定を変更していなければ、`init` が作ったバックアップから設定を戻す方法も使えます。設定から sumi の呼び出しを取り除いた後、不要になったバイナリと secrets ファイルを削除できます。先にバイナリだけを削除すると、Claude Code に動かない hook 設定が残ります。

## CLI

```text
sumi init   --agent claude --secrets-file F [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]
sumi run    --secrets-file F -- PROGRAM [ARGS...]
sumi filter --secrets-file F
sumi --version
```

- `--agent claude`: 利用するエージェントを指定します。`init` では必須で、現在は `claude` だけに対応します。
- `--secrets-file F`: 1 行 1 値の secrets ファイルを指定します。
- `--root DIR`: `@` 添付の相対パスを解決する基準を追加します。繰り返し指定できます。Claude Code の `--add-dir` や `permissions.additionalDirectories` を使う場合は、同じディレクトリを指定してください。
- `--deny-path P`: `@` を除いた添付トークンに `P` が含まれる場合、中身に関係なく拒否します。繰り返し指定できます。
- `--settings FILE`: `init` が書く設定ファイルを指定します。既定は `$CLAUDE_CONFIG_DIR/settings.json`、環境変数がなければ `~/.claude/settings.json` です。
- `--shell PATH`: Bash コマンドを渡すシェルの絶対パスです。既定では `init` 時の `PATH` から `bash` を解決します。

`run` は子プロセスの stdout と stderr をマスクし、子の終了ステータスを保ちます。`PROGRAM` は `PATH` から探さないため、`/bin/bash` のようにパスを指定してください。安全にマスクできないエラーでは出力を捨てて 121 で終了しますが、子自身の exit 121 とは区別できません。`filter` は stdin をマスクして stdout へ流し、動作確認にも使えます。

## 開発・検証

ソースから確認するには、このリポジトリで次を実行します。

```bash
cd contrib/sumi
zig build test
zig build
./tests/run-tests.sh
```

ビルドには Zig 0.15.2、ブラックボックステストには `jq` が必要です。Claude Code の更新時には、[手動検証手順](tests/manual-validation.md)で保護する経路の動作を確認してください。[検証記録](tests/validation-results.md)に確認したバージョンと結果を残しています。
