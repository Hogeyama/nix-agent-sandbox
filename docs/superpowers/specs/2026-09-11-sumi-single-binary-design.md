# sumi: 列挙した値を Claude Code に見せない単一バイナリ

Status: Approved — 2026-09-11

Date: 2026-09-11

## この設計で決めること

利用者がファイルに列挙した値 (ソースコードや git 履歴に残っている認証情報) を、
Claude Code のモデルに平文のまま渡さないための道具 `sumi` を作る。GitHub Release から
ファイルを 1 つ落として `init` を叩けば動く単一バイナリで、その CLI と挙動、守らないもの、
リポジトリ内での置き場所、配布方法をこの文書で決める。関数分割とコミット順序は承認後の
実装計画で扱う。

sumi は nas の外で、nas 無しに使う道具である。nas がコンテナ内で使う `nas-mask-filter`
とマスクの実装を共有するが、nas の pipeline からは参照しない。

## 利用時の動作

導入は curl 1 回と `init` 1 回で終わる。git clone も Nix も jq も要らない。

```bash
curl -fsSLo ~/.local/bin/sumi \
  https://github.com/Hogeyama/nix-agent-sandbox/releases/latest/download/sumi-x86_64-linux
chmod +x ~/.local/bin/sumi

mkdir -p ~/.claude/sumi
install -m 600 /dev/null ~/.claude/sumi/secrets.txt
$EDITOR ~/.claude/sumi/secrets.txt

sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt
```

`--agent` は必須で、既定値を置かない。nas と同じく sumi も特定のエージェント専用の
道具にはしないが、hook の JSON 形式と settings の置き場所はエージェントごとに違う。
この設計で実装するのは `claude` (Claude Code) だけで、他の値は「未対応」として
exit 2 で拒否する。将来の追加はこのオプションの値を増やす形で行う。

`init` は Claude Code のユーザー設定に hook を 4 つ書き込む。イベントは
PreToolUse (matcher `Bash`)、PostToolUse、PostToolUseFailure、UserPromptSubmit で、
PostToolUse と PostToolUseFailure は同じ command を共有するので、command は 3 種類である。
command には `sumi` 自身の絶対パス (`/proc/self/exe` の解決結果) を書く。常駐プロセスは無い。

以後、secrets ファイルに書かれた値は、ツール出力と Bash 出力の中で同じ長さの `*` に
置き換わる。値を含む部分以外は読めるので、エージェントは通常どおり作業できる。値を含む
ファイルを `@` で添付しようとしたときだけは、置き換えではなく拒否になる。

```properties
# ファイルの実体
db.password=Tr0ub4dor
# エージェントが見るもの
db.password=*********
```

secrets ファイルは 1 行 1 値の平文である。空行は無視し、行末の LF だけを取り除き、
それ以外の空白は値の一部として扱う。各値は UTF-8 として有効で 4 バイト以上、全体で
1024 件以下とする。4 バイト未満の値は無関係な出力にも頻繫に一致して出力の大半を潰すため
拒否し、件数の上限は 1 回の hook で走査するコストを抑えるためである。sumi はこのファイル
を直接読み、中間ファイルを作らない。平文が置かれる場所は secrets ファイルと各プロセスの
メモリだけである。

## 塞ぐ経路

シークレットがモデルへ届く経路と、それぞれの扱いは次のとおり。

| 経路 | 例 | 扱い |
| --- | --- | --- |
| 成功したツール呼び出しの出力 | `Read`、`Grep` の content、MCP ツールの戻り | mask |
| Bash の出力 (成功・失敗を問わず) | `cat path`、`git show HEAD:path`、`cat path && false` | mask |
| 失敗した Bash 以外のツール呼び出し | `Edit` の不一致 | 報告のみ |
| プロンプトへの `@` 添付 | `@path` | deny |

Claude Code 側の合流点は 3 つで、それぞれに hook を置く。

```
                    ┌─ Read / Grep / Edit / MCP / LSP / Bash(成功時)
                    │        └─ tool_response ──→ PostToolUse: sumi hook post-tool ──→ モデル
 Claude Code ───────┤
                    └─ Bash
                          └─ PreToolUse: sumi hook pre-bash がコマンドを書き換える
                                 └─ sumi run -- bash -c "元のコマンド"
                                        └─ stdout/stderr をその場でマスク ──→ (PostToolUse を経て) モデル

 ユーザーのプロンプト ──→ UserPromptSubmit: sumi hook prompt
                                 └─ 保護対象の値を含む @ 添付なら拒否
```

3 系統に分かれるのは、どれか 1 つでは覆えないからである。

PostToolUse は成功したツール呼び出しの `tool_response` を差し替えられる。ここを通る
ものは、Bash の成功時の出力も含めて自動的に守られ、新しいツールが増えても同じである。
一方、失敗した呼び出しは PostToolUseFailure に回り、そのペイロードの `error` は差し替えを
受け付けない (Claude Code 2.1.266 で実測)。

そこで Bash は PreToolUse でコマンドを `sumi run` の下に書き換え、Claude Code が
1 バイトも読む前のパイプでマスクする。成功時は書き換え後の出力が PostToolUse も通るが、
既にマスク済みなので変化しない。Bash 以外のツールの失敗にはこの手当てが無く、`error` に
値が含まれていれば報告するだけになる。組み込みツールの失敗本文にファイルの内容が
入らないこと (`Edit` は「見つからなかった」とモデル自身が渡した文字列だけ、`Grep` の
不一致は件数だけ) を実測しているので、現状は漏れない。ただしこれは今の文面がそうである
という話で、Claude Code の更新で変わりうる。

`@` 添付はツール呼び出しではない。UserPromptSubmit のペイロードには `@path` という文字
だけが入って内容は入らず (実測)、プロンプトは書き換えられない。sumi は添付先を自分で
開いて調べ、値があればプロンプトを拒否する。

## 守らないもの

sumi が守るのは「hook が動いている限り、上の表に挙げた経路で、列挙した値がそのままの
バイト列でモデルへ届かない」ことである。次は守らない。README の「限界」にも同じ一覧を載せる。

- **変換された値。** 一致判定はバイト列の完全一致である。`base64` や `xxd` を挟んだ出力、
  UTF-8 として不正な値 (Claude Code がファイルを UTF-8 として読む時点で置換される)、
  JSON の数値・真偽値として現れる値 (文字列リーフだけをマスクする) は素通る。
- **hook を通らない実行。** `/dev/tty` への直接書き込み、`bash` を経由しないプロセス起動、
  Bash から入れ子で起動した `claude --bare` や `--settings '{"disableAllHooks":true}'`。
- **hook が起動できない状態。** Claude Code は hook の非ゼロ終了 (exit 2 を除く) を
  non-blocking error として扱い、元の出力をモデルへ渡す。sumi のバイナリを移動・削除した、
  hook の `timeout` (init は 20 秒を書く) を超えた、のいずれも fail-open になる。
  secrets ファイルの不備は sumi 自身が検出して fail-closed にできるが、この 2 つは
  sumi のコードの外で起きる。`init` の自己診断と README の「バイナリを動かしたら init を
  再実行する」で補う。
- **Bash 以外のツールの失敗本文。** 上述のとおり報告だけになる。
- **走査上限の外。** `@` 添付の検査は 1 ファイル先頭 32 MiB、ディレクトリ直下 100 件、
  名前による探索は深さ 6 で 50 件までである。hook 全体に 15 秒の期限を置き、期限内に
  検査し終えなかった添付は「検証できなかった」として拒否する (これは fail-closed)。
- **エージェント自身による無効化。** sumi はエージェントと同じ UID で動くので、
  エージェントは settings を書き換えて hook を外せる。事故防止には足りるが、エージェント
  を信頼しないなら、バイナリと secrets ファイルを root 所有にし、`sumi init --agent claude
  --settings /etc/claude-code/managed-settings.json` を root で実行して管理者設定に書く。
  管理者設定は下位の設定から上書きされず、`disableAllHooks` もユーザー設定からは
  変えられない。ただし `--bare` を禁止する手段は無い。README の「固める構成」に手順を載せる。
- **列挙されていない値。** ローテーションで退役した古い値も履歴に残るなら列挙する必要が
  ある。secrets ファイルに足せば次の hook 呼び出しから効く。

この構成は「列挙した値」を「列挙した合流点」で潰す仕組みである。ツール呼び出しではない
注入経路 (IDE が共有する選択範囲、自動で読み込まれる `CLAUDE.md`、SessionStart hook の
`additionalContext`、スラッシュコマンドの `!` 展開) は PostToolUse を通らず、`@` 添付と
同じく個別の手当てが要るが、この設計では `@` 添付だけを扱う。新しい経路が増えたとき、
既定では漏れる側に倒れ、テストも警告も出ない。したがって経路の一覧を Claude Code の更新
ごとに見直す運用を前提にする。

## CLI

```
sumi init   --agent claude --secrets-file F [--root DIR]... [--deny-path P]... [--settings FILE] [--shell PATH]
sumi hook   --agent claude post-tool --secrets-file F
sumi hook   --agent claude prompt    --secrets-file F [--root DIR]... [--deny-path P]...
sumi hook   --agent claude pre-bash  --secrets-file F --shell PATH
sumi run    --secrets-file F -- PROGRAM [ARGS...]
sumi filter --secrets-file F
sumi --version
```

`--agent` を取るのは `init` と `hook` である。`run` と `filter` はバイト列しか扱わず、
エージェントに依存しない。`hook` の command は `init` が書くので利用者が手で打つ
ことは無いが、hook サブコマンドの JSON 形式もエージェント固有なので、値を明示させて
どの形式を期待しているかを command 自体に残す。

オプションの意味は次のとおり。

- `--secrets-file F`: 上述の平文ファイル。
- `--root DIR`: `@` 添付の相対パスを解決する基準ディレクトリを追加する (繰り返し可)。
  Claude Code は `--add-dir` と `permissions.additionalDirectories` で足したディレクトリ
  にも `@` を解決するが、hook のペイロードはそれを教えてくれない。それらを使うなら
  ここに渡す。渡さないと、そこにあるファイルの添付は「検証できなかった」として拒否される。
- `--deny-path P`: `@` トークンの `@` を除いた文字列が P を部分文字列として含むとき、
  中身に関係なく添付を拒否する (繰り返し可)。添付は中身を検査されるので通常は要らず、
  名前で門前払いしたいファイルのためにある。
- `--settings FILE`: `init` が書き込む settings ファイル。`--agent claude` の既定値は
  `$CLAUDE_CONFIG_DIR/settings.json`、環境変数が無ければ `~/.claude/settings.json`。
- `--shell PATH`: pre-bash が書き換え後のコマンドを渡すシェルの絶対パス。`init` の既定値は
  `init` 実行時の PATH で `bash` を解決した絶対パスで、`init` はそれが実行可能であることを
  確かめて hook command に書き込む。`run` は PATH 探索をしないので、hook 側では必須にする。

### init

1. secrets ファイルを読み、形式を検証する。読めない・空・短い値・UTF-8 として不正な値が
   ある場合は settings に触らず exit 1 で止まる。mode が 600 / 640 / 400 以外なら警告を出す。
2. `/proc/self/exe` を readlink して自分の絶対パスを得る。それが `/tmp`、`$TMPDIR`、
   `~/Downloads` の下なら「片付けると hook が動かなくなる」と警告する。
3. `--shell` (既定は PATH の `bash`) が実行可能であることを確かめる。無ければ exit 1。
4. settings ファイルを読む (無ければ `{}` から始める)。不正な JSON なら exit 1。重複キーは
   JavaScript の `JSON.parse` と同じく後勝ちで読む。
5. `<settings>.bak.<YYYYmmddHHMMSS>` にバックアップを取る。
6. `disableAllHooks` を `false` にする。4 イベントの配列それぞれから、command の先頭語の
   basename が自分の basename と一致し、次の語が `hook` である entry を取り除き、sumi の
   entry を追加する。他の entry と他のキーはそのまま残す。これで再実行は冪等になり、
   利用者の formatter や通知の hook は消えない。
7. sumi の entry は `{ "type": "command", "command": "...", "timeout": 20 }` で、
   command の各引数は POSIX シェルとして安全に quote する (Claude Code は command を
   `sh -c` で実行する)。PreToolUse の entry には `"matcher": "Bash"` を付ける。
8. 2 スペースインデントで書き戻す。
9. 自己診断として、書き込んだ 3 種類の command を `sh -c` で実際に起動する。post-tool には
   保護対象の値を含む合成 PostToolUse ペイロードを渡し、値が `*` に置き換わったことを
   確認する。pre-bash には合成 Bash ペイロードを渡し、返ってきた書き換え後の command を
   `sh -c` で実行して、出力がマスクされ終了ステータスが保たれることを確認する。prompt には
   無害なプロンプトを渡し、素通りすることを確認する。失敗すれば exit 1 で報告する
   (settings は書き込み済みなので、バックアップの場所を示す)。

`--root` / `--deny-path` は prompt hook の command に、`--shell` は pre-bash hook の
command に、`--agent` と `--secrets-file` は 3 種類すべてに転記する。

settings を書く先がユーザー設定なのは、プロジェクト設定では足りないからである。
`.claude/settings.json` はセッションを開始したディレクトリ基準で読まれ、リポジトリの
サブディレクトリから `claude` を起動すると hook が読まれない (実測)。

### hook post-tool

1. stdin のペイロードを JSON として parse する。parse できなければ、`hookEventName` を
   `PostToolUse` として出力を差し止める (withhold)。重複キーは後勝ち。
2. `hook_event_name` が `PostToolUseFailure` なら `error` の文字列を検査し、値が含まれて
   いれば `systemMessage` だけを返す。このイベントでは差し替えも exit 2 も出力を止められない
   ので、起きたことを報告するに留める。secrets ファイルが読めない場合も同じ理由で
   `systemMessage` だけを返す。
3. `tool_response` の中の文字列リーフとオブジェクトのキーを、デコード済みのバイト列に
   対してマスクする。JSON テキストではなく値をマスクするので、引用符やバックスラッシュ、
   `\uXXXX` を含む値もそのまま置き換わり、JSON の構造トークンや数値と一致する値を
   secrets に置いても JSON は壊れない。数値と真偽値のリーフは対象にしない。
4. どのリーフも変わらなければ何も出さずに exit 0。`tool_input` は検査しない。モデル自身が
   書いた入力であって、モデルへ渡す出力ではないからである。
5. 変わっていれば `tool_response` を書き戻し、`hookSpecificOutput.updatedToolOutput` に
   載せる。`hookEventName` はペイロードのイベント名を返す。

`tool_response` を書き戻すとキー順は保たれるが、数値の表記は正規化されうる (`1.50` が
`1.5` になる)。差し替えが起きるのは値がマスクされたときだけなので許容する。

### hook prompt

1. プロンプトから `@` トークンを抽出する。`@` は行頭か空白の直後にあるものだけを
   対象にし (メールアドレスを添付と見ない)、バックスラッシュでエスケープした空白は
   トークンの一部として扱う。先頭の `~/` は `$HOME/` に展開する。
2. `--deny-path` に一致するトークンがあれば、中身に関係なく拒否する。
3. `://` を含むトークンは MCP リソースの参照 (`@server:scheme://path`) であり、sumi は
   その内容を取得できないので拒否する。内容が要るなら、ツール呼び出しである
   `ReadMcpResource` を使えば PostToolUse でマスクされる。
4. 各トークンを、ペイロードの `cwd` と `--root` の各ディレクトリを基準に解決する。
   絶対パスはそのまま使う。ファイルなら先頭 32 MiB を検査し、ディレクトリなら直下の
   ファイル 100 件までを 1 つずつ検査する。値があれば拒否する。
5. どの基準でも見つからなければ、同じファイル名を各基準の下で深さ 6、50 件まで探し、
   見つかったものを検査する。Claude Code が `--add-dir` などこちらの知らない基準で
   解決した可能性を拾うためである。
6. それでも見つからず、しかもパスの形 (`/` を含む、または英字始まり 1〜4 文字の
   拡張子で終わる) をしているトークンは「検証できなかった」として拒否する。
   `@Override`、`user@example.com`、`@v1.2.3`、`@agent-general-purpose` は通る。
7. 最後にプロンプト本文をマスクし、変化があれば拒否する。プロンプトは書き換えられず、
   拒否しか選べない。

hook 全体に 15 秒の期限を置く。期限が来たら、残りのトークンは検査せずに「検証できなかった」
として拒否する。settings の `timeout` (20 秒) を超えると Claude Code 側で fail-open に
なるので、その前に自分で fail-closed に倒す。

### hook pre-bash

`tool_input.command` を `<self> run --secrets-file F -- <shell> -c <command>` に書き換えて
`hookSpecificOutput.updatedInput` で返す。`<self>` は `/proc/self/exe` の解決結果、各引数は
POSIX シェルとして安全に quote する。command が既に `<self> run ` で始まる場合は触らない。

`permissionDecision` は返さない。返すと `allow` なら全 Bash が承認プロンプトを迂回し、
`ask` でも通常の判定を上書きする。返さなければ、書き換え後の command に対して通常の
権限判定が行われる。

書き換えの代償として、Claude Code からは本来のコマンドが見えなくなる。パスベースの
`Read` deny ルールが Bash の `cat` に効かなくなり、`Bash(...)` の allow ルールは
ラッパーに対して照合される (いずれも実測)。この代償を払えない利用者は PreToolUse の
hook だけを settings から外せる (`init` を再実行すると戻る)。その場合、非ゼロ終了した
コマンドの出力は素通る。

### run と filter

`run` は子プロセスを fork/exec し、stdout と stderr をパイプで受けてこのプロセス内で
マスクし、書き戻す。子の終了ステータスで終わる。パイプの読み取りエラーやメモリ確保の
失敗など、マスクされたと確信できないバイト列が生じた場合は出力を捨てて 121 で終わる。
出力先が先に閉じられた場合 (`cmd | head`) だけは、マスクは最後まで効いているので、診断を
出さず子のステータスで終わる。121 は `nas-mask-filter` と共有する「出力抑止」の値で、
子が自ら 121 で終わった場合と区別できないことは限界として README に載せる。

`run` は子の環境に `SUMI_SUPERVISED=1` を足す。入れ子で `run` が動いたとき二重に
マスクしないための印である。

`filter` は stdin を stdout へマスクして流す。テストと動作確認のために置く。

### 終了コードの規約

引数の解釈に失敗した場合は exit 2 で usage を出す。`init` が書いた command を手で壊した
場合にしか起きない。exit 2 の扱いはイベントによって違い、PreToolUse と UserPromptSubmit
ではブロック、PostToolUse と PostToolUseFailure では hook error として画面に出た上で元の
出力が通る。

引数の解釈が終わった後は、どの失敗でも exit 0 で決定を返す。secrets ファイルが読めない・
空・短い値を含む、ペイロードが parse できない、のいずれも同じである。post-tool は差し止め
(`updatedToolOutput` を通知文に置き換える)、prompt は `decision: block`、pre-bash は
`permissionDecision: deny`。理由はいずれも `systemMessage` または reason に
`sumi: <理由>` の形で載せる。PostToolUseFailure だけは差し止め手段が無いので
`systemMessage` のみになる。

この規約の帰結として、secrets ファイルが読めない状態では全ツール出力が差し止められ、
全 Bash が拒否され、Claude Code は事実上使えなくなる。マスクなしで動き続けるより
止まる方を選ぶ。

## 内部構造

### 置き場所

```
contrib/sumi/
  build.zig                 # sumi 実行ファイルと unit test
  main.zig                  # サブコマンドの振り分けと引数解釈 (--agent の検証を含む)
  secrets.zig               # 平文 secrets ファイルの読み込みと検証
  claude/hook_post.zig      # post-tool: JSON の parse、リーフのマスク、書き戻し
  claude/hook_prompt.zig    # prompt: @ トークン抽出、ファイル走査、パス形判定
  claude/hook_bash.zig      # pre-bash: command の書き換えと quote
  claude/init.zig           # settings.json のマージと自己診断
  tests/run-tests.sh        # 黒箱テスト
  README.md                 # 導入手順、塞ぐ経路、守らないもの、固める構成、実測
```

`contrib/` は「nas 本体とは独立に使えるが、コードを共有するもの」の置き場として
新設する。エージェント固有のコード (hook の JSON 形式、settings の置き場所と形) は
`claude/` 配下に閉じ込める。`main.zig` は `--agent` の値でディレクトリを選ぶだけに
留め、値に依存しない `secrets.zig`、`run`、`filter` は最上位に置く。

### 共有するコード

nas には Zig で書かれたマスクの実装が 2 か所ある。

- `src/zig/mask.zig`: バイト列の完全一致置換。バッファ内の各値の全出現を同じ長さの `*` に
  置き換える。
- `src/mask-filter/`: `nas-mask-filter` の実装。`mask_stream.zig` はストリームを
  チャンク境界を跨いでマスクし、`supervise.zig` は子プロセスを fork/exec してその
  stdout / stderr をパイプで受け、マスクして書き戻し、子の終了ステータスで終わる。
  `supervise.zig` は `mask_stream.zig` と `relay.zig` を相対パスで import している。

Zig ではファイルは 1 つのモジュールにしか属せないので、`supervise.zig` と
`mask_stream.zig` を別々のモジュールとして取り込むことはできない。`contrib/sumi/build.zig`
は `src/mask-filter/supervise.zig` をルートとする 1 つのモジュールを作り、そこに
`src/zig/mask.zig` を `mask` という名前で import させる。`supervise.zig` は
`mask_stream.zig` を `pub const` で再エクスポートし、sumi はそれを通して
`streamMask` を使う。

### JSON の扱い

`std.json` の `Value` を使う。parse は重複キーを後勝ちにする。post-tool は `Value` の
文字列リーフとキーを in-place でマスクし、`Stringify` で書き戻す。`ObjectMap` は挿入順を
保つ。`init` の settings も同じ `Value` で読み書きし、2 スペースインデントで出力する。
コメント付き JSON (JSONC) は Claude Code 側が受け付けないので考慮しない。

### セキュリティ上の位置づけ

security-constraints は nas のコンテナ境界に関する不変条件である。sumi はコンテナの外、
Claude Code と同じ UID のホスト上で動き、nas のコンテナ内では使わないので、それらの
対象ではない。関係するのは共有コードへの変更だけで、`nas-mask-filter` の側を弱めない
ことを「nas 側の変更」で扱う。

## 配布

### Nix

flake に `packages.sumi` を 1 つ足す。`stdenv.mkDerivation` で、src は
`lib.fileset` で `contrib/sumi`、`src/mask-filter`、`src/zig` を集めたもの (root は
リポジトリ直下)、`sourceRoot` は `source/contrib/sumi`。`zig build` に
`-Dtarget=<cpu>-linux-musl -Doptimize=ReleaseSafe -Dstrip=true -Dversion=<rev>` を渡す。
`<cpu>` は `stdenv.hostPlatform.parsed.cpu.name` (`x86_64` / `aarch64`) から組む。
`native-linux-musl` はビルドマシンの CPU 拡張に依存するバイナリになるので使わない。
`<rev>` は `self.shortRev`、無ければ `dirty`。unit test は実行ファイルのターゲットとは
別にホスト向けにビルドして `checkPhase` で走らせる (既存の `src/mask-filter/build.zig` と
同じ構成)。成果物は glibc に依存しない単一ファイルで、nix-bundle-elf は使わない。

### GitHub Release

`release.yml` は x86_64 と aarch64 のランナーで同じ job を走らせている。そこに
`nix build .#sumi` を足し、成果物を `sumi-x86_64-linux` と `sumi-aarch64-linux` として
そのまま (tar にせず) Release に添付する。ファイル名にタグを含めないのは、
`releases/latest/download/<name>` の URL を安定させるためである。既存の成果物
(`nas-<tag>_<system>.tar.gz`、`maskfs-<tag>_<system>.tar.gz`) の命名は変えない。
`sumi --version` は `sumi <rev>` を出す。

## nas 側の変更

`src/mask-filter/supervise.zig` に `runLocal` を足す。既存の `run` はコンテナ内で動き、
生バイトを Unix socket 越しにホストのブローカーへ送ってマスク済みを受け取る。
`runLocal` は同じ監督ループで、ブローカーを介さずこのプロセス内でマスクする。
子プロセスの起動部分は `run` と共有し、診断メッセージのプログラム名と子に付ける環境変数
の名前は引数で受ける (nas 側は `nas-mask-filter` と `NAS_MASK_SUPERVISED`、sumi は
`sumi` と `SUMI_SUPERVISED`)。`mask_stream.zig` を `pub const` で再エクスポートする。

`nas-mask-filter` の CLI からは `runLocal` を呼べるようにしない。コンテナへ配る
バイナリにローカルマスクの入口を置くと、シークレットの一覧をコンテナ内で読む使い方を
選択肢として提供することになり、security-constraints C1 / S1 の前提を崩す。
呼び出し元は sumi だけである。`mask_filter.zig` の引数解釈、usage、ヘッダコメント、
テストは変更しない。

## 検証と受け入れ条件

- `zig build test` の unit test: secrets ファイルの解析 (空行、短い値、UTF-8 不正、
  件数上限、LF 以外を保持)、引数解釈 (`--agent` の必須と未対応値の拒否を含む)、
  `@` トークン抽出 (`~/` 展開、`://` の判定を含む)、パス形判定、`Value` のリーフの
  マスク (エスケープを含む値、キー、数値リーフの非対象)、シェル quote、settings の
  マージ (他 entry と他キーの保持、自分の entry の置き換え、`disableAllHooks`、重複キー)。
- `tests/run-tests.sh` の黒箱テスト。デコイ値だけを使い、hook に JSON を流して判定を
  確かめる。少なくとも次を含む。
  - post-tool: `Read` の出力に含まれる値がマスクされる。`git show` の出力に含まれる
    (現在のファイルには無く履歴にだけある) 値がマスクされる。値を含まない出力は
    何も出さずに通る。`tool_input` にだけ値がある場合は差し替えない。引用符を含む値が
    マスクされる。`true` や数値と一致する値を secrets に置いても JSON が壊れない。
    secrets ファイルが無い・空のときは差し止める。PostToolUseFailure に値があれば
    `systemMessage` だけを返し、無ければ何も出さない。
  - prompt: 値を含むプロンプトの拒否、`--deny-path` の拒否、通常のプロンプトの許可、
    ファイル名を文中で挙げるだけ (添付しない) の許可、値を含む添付 (テキスト・バイナリ・
    ディレクトリ・絶対パス・別の場所で名前が一致) の拒否、値を含まない添付の許可、
    検証できない添付の拒否、アノテーション・メールアドレス・バージョンタグ・
    `@agent-` の許可、MCP リソースの拒否、`--root` の効果。
  - pre-bash: 書き換えの形、`permissionDecision` を返さないこと、失敗するコマンドの
    出力のマスク、終了ステータスの保持、secrets ファイルが読めない・空のときの deny、
    既に書き換え済みの command を触らないこと。
- `sumi init` を空の settings に対して実行し、4 イベントが書かれ、自己診断が通る。
  既存の settings に対しては他の entry と他のキーが保持され、バックアップが残り、
  再実行で entry が増えない。`--shell` が無いとき、secrets ファイルが不正なときは
  settings に触らず exit 1 になる。
- `nix build .#sumi` の成果物が `ldd` で "not a dynamic executable" になり、
  `--version` が rev を出す。
- `nas-mask-filter` の既存 unit test と nas の `bun run test:unit` が通る。
- Claude Code 2.1.266 以降で、「塞ぐ経路」の 4 行、`@` 添付の周辺挙動、権限プロンプトと
  ルール照合が従来どおり出ることを捨てリポジトリで手動確認し、結果を README の実測表に載せる。

## なぜこのアプローチを選んだか

配布の要件は「1 ファイル落とすだけ」で、hook はツール呼び出しごとに起動する。
マスクの本体 (完全一致置換、子プロセスの監督) は nas のために既に Zig で書かれており、
hook 側に必要なのは JSON の出し入れ、ファイル走査、settings のマージだけである。
これを同じ Zig で書けば、外部コマンドへの依存が無くなり、Zig の musl クロスコンパイルで
静的バイナリが直接得られる。起動コストもミリ秒単位で済む。

`contrib/` に置くのは、nas 本体の pipeline から独立して使えることを構造で示す
ためである。一方でコードは共有し、マスクの意味論が 2 か所に分かれないようにする。

## 他のアプローチを採らない理由

- **API へ出ていく HTTPS をマスクする**: 経路の種類に依存せず合流点を 1 つに絞れる。
  Claude Code 自身は `HTTPS_PROXY` と `NODE_EXTRA_CA_CERTS` を読むので、TLS を終端する
  プロキシを常駐させて環境変数を付けて起動すれば成立し、bwrap で netns を切れば強制にも
  できる。しかし Zig の std には TLS サーバが無く、プロキシは別言語か TLS ライブラリの
  静的リンクになる。さらに強制にすると、エージェントが使う git や Gradle などプロキシを
  読まないツールごとに環境変数や証明書を注入する仕組みが要り、nas の縮小版を作ることに
  なる。hook 版は Claude Code の hook API の細部に判断が張り付く弱さがあるが、到達点が
  見えている。この設計では hook 版を採り、HTTPS 版は将来の選択肢として残す。
- **bash + jq のスクリプトとして配る**: 導入が git clone か複数ファイルの配置になり、
  マスク本体の Zig バイナリを別途入手させる必要がある。`jq` が無い環境では hook が
  非ゼロで終わり、Claude Code はそれを non-blocking error として元の出力を通すので、
  依存の欠落がそのまま fail-open になる。
- **Bun で書いて `bun build --compile` する**: JSON 処理は楽だが、バイナリが 90 MB 級で
  hook ごとの起動が数十 ms かかる。子プロセスの監督を再実装するか、Zig バイナリを
  同梱して実行時に展開する必要があり、nas と独立させたい意図とも合わない。
- **`nas-mask-filter` にサブコマンドを足す**: 配布物が nas の名前を背負い、コンテナへ
  配るバイナリに hook と settings 書き換えの入口が乗る。用途が違うものは別バイナリに
  分け、コードだけ共有する。
- **nix-bundle-elf で glibc ごと束ねる**: 既存の nas / maskfs と同じ手だが、Zig は
  musl を自前で持っているので、束ねるより静的リンクの方が小さく単純になる。
