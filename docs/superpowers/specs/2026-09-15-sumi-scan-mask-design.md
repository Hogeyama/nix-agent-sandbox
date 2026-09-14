# sumi scan: 秘密を含むファイルを sandbox の credentials mask に登録する

Status: Draft — 2026-09-15

Date: 2026-09-15

## この設計で決めること

`sumi scan` を作り直す。0.1.0 の `scan` は、値を含むファイルを
`sandbox.filesystem.denyRead` に列挙していた。新しい `scan` は、値を含むファイルを
Claude Code の `sandbox.credentials.files` に `mode: "mask"` で登録する。

- 登録したファイルを sandbox 内の Bash が読むと、値の部分だけが身代わりの値
  (sentinel) に置き換わる。
- 登録できないファイルは書かずに、理由を表示する。

この文書で決めるのは次のものである。関数分割とコミット順序は実装計画で扱う。

- CLI と挙動
- extract の生成規則と検証
- 設定ファイルへの反映規則
- コード構成
- 受け入れ条件

走査の速度改善 (パターン照合を 1 回の走査にする、並列に読む) はこの設計に
含めない。`src/zig/mask.zig` は nas と共有しているので、別の設計で扱う
(`docs/todo/sumi.md` の 2)。

## 検証の書き方

Claude Code の挙動についての主張には ID を付け、根拠を次のいずれかで示す。
対象は Claude Code 2.1.268、Linux (x86_64、bubblewrap が使える環境) である。

- **D (ドキュメント)**: ページの URL と原文の引用。一括取得は
  `curl -fsSL https://code.claude.com/docs/llms-full.txt` でもできる。
- **B (バイナリ)**: Claude Code 実行ファイル内の文字列。次のコマンドで件数が
  1 以上になることを確かめる。

  ```bash
  f=$(readlink -f "$(command -v claude)")
  LC_ALL=C grep -a -c -F '<文字列>' "$f"
  ```

  説明文やログ文言は実装の意図を示すが、仕様としての約束ではない。
- **E (実験)**: 手順と観測結果。ホストでの実験は
  `docs/superpowers/probes/2026-09-15-sumi-credential-mask-probe.sh [listed|empty|omitted|dup-on|dup-off]`
  で再現できる。この probe は bubblewrap が使えるホストで、デコイ値だけを使う。

根拠が推測に留まるものは「未確認事項」の節に分け、確かめる方法と、結果が
異なった場合の扱いを書く。

## 前提となる Claude Code の仕様

### F1: mask はプロジェクト設定では無視される

- D: https://code.claude.com/docs/en/sandboxing#mask-environment-variables
  > Claude Code honors it only from settings you or your administrator control:
  > user settings, managed settings, and the `--settings` CLI flag. Claude Code
  > ignores `mask` entries in a repository's `.claude/settings.json` or
  > `.claude/settings.local.json`.
- D: https://code.claude.com/docs/en/sandboxing#mask-credential-files
  > On every platform, Claude Code applies the `network.tlsTerminate` requirement
  > and `injectHosts` the same way as for masked environment variables, and
  > ignores repository settings the same way.
- 帰結: `scan` は mask をユーザー設定、または `--settings` で指定されたファイルに
  書く。プロジェクトの `.claude/` を書き込み先に指定されたら拒否する。
- 実験で確かめていないこと: プロジェクト設定に書いた mask が実際に無視されること。
  設計はドキュメントに従ってそこには書かないので、この挙動には依存しない。

### F2: ユーザー設定の相対パスは `~/.claude` 基準で解決される

- D: https://code.claude.com/docs/en/sandboxing#protect-credentials
  > File paths follow the same prefix rules as `sandbox.filesystem.*` settings.
- D: https://code.claude.com/docs/en/settings-reference#sandbox-path-prefixes
  > | `./` or no prefix | Relative to the project root for project settings, or to `~/.claude` for user settings |
- B: `project root for project settings, ~/.claude for user settings`
  (`credentials.files[].path` の説明文)
- 帰結: `scan` は `path` を絶対パスで書く。
- 実験で確かめていないこと: `credentials.files` の相対パスが、ユーザー設定で
  `~/.claude` 基準になること。設計は常に絶対パスを使うので、この挙動には依存しない。

### F3: ファイル mask は extract の各一致のグループ 1 だけを置き換える

- D: https://code.claude.com/docs/en/sandboxing#mask-credential-files
  > Claude Code applies the regular expression across the whole file and replaces
  > only the text captured by group 1 of each match
  >
  > Without `extract`, Claude Code replaces the entire file content with one
  > sentinel value
- E1 (`probe listed`):
  - sandbox 内の `cat app.properties` は `api.token=fake_value_<uuid>` を返し、
    本物の値を含まなかった。
  - `od -An -c app.properties` の出力から空白と改行を除いても、本物の値は
    現れなかった。
- 帰結: 一致全体に前置き (キーと区切り) が含まれても、置き換わるのはグループ 1
  だけである。前置きを後読みにする必要は無い。

### F4: extract は JavaScript の `RegExp` として検証され、グループが必須

- D: https://code.claude.com/docs/en/sandboxing#mask-credential-files
  > the pattern must contain at least one capturing group
- B: `o=new RegExp(e)`、`extract must contain at least one capturing group`

### F5: extract はファイル全体に繰り返し適用される。その他のフラグは不明

- B: `Applied globally` (`extract` の説明文)
- 不明な点: `m`、`i`、`s`、`u`、`y` などのフラグが付くかどうか。
- 帰結: 生成する extract は次のものを使わない。どれもフラグで意味が変わるためである。
  - `^` と `$`
  - `.`
  - `\w` と `\s`
  - 大文字小文字の同一視
  - Unicode プロパティ

  文字の集合は、明示した文字の列挙だけで書く。

### F6: `onExtractNoMatch: "deny"` なら、一致しないときにファイルを読めなくする

- D: https://code.claude.com/docs/en/sandboxing#mask-credential-files
  > `deny` makes the file unreadable instead

### F7: mask できないファイルは deny に落ちる

- D: https://code.claude.com/docs/en/sandboxing#mask-credential-files
  > Claude Code falls back to `deny` for a `mask` entry it can't mask safely: a
  > directory path, a glob pattern, a file larger than 8 MiB, or a file that isn't
  > UTF-8 text.
- 帰結: `scan` はこれらに当たるファイルを登録しない。deny に落ちると、ビルドが
  そのファイルを読めなくなるためである。

### F8: `injectHosts` を省略すると、`allowedDomains` の全ホストで差し替える

- D: https://code.claude.com/docs/en/sandboxing#mask-environment-variables
  > `NPM_TOKEN` has no `injectHosts` and is substituted on requests to every host
  > in `network.allowedDomains`.
- ファイル mask にも同じ規則が適用される (F1 の 2 つ目の引用)。
- 帰結: `scan` は `injectHosts` を省略しない。
- 再現方法: `probe omitted` で、リスナーが本物の値を受け取ることを確かめられる
  (未実行)。

### F9: 同じファイルに credentials の deny があると、mask は捨てられる

- B: `denies the same file`。該当箇所の全文は
  `credential file mask for '${$o.path}' dropped: '${zl}' denies the same file`
  である。
- 帰結: 同じパスに利用者のエントリがあれば、`scan` は触らない。
- 未確認: `sandbox.filesystem.denyRead` に同じパスがある場合にも mask が捨てられるか
  (U3)。

### F10: 許可したホストへの送信で本物に差し替わる。プライベート IP は proxy を通らない

- E1 (`probe listed`)
  - 設定:
    - `injectHosts: ["<LAN IP の . を - にしたもの>.nip.io"]`
    - `network.allowedDomains` に同じホスト名
    - `credentials.allowPlaintextInject: true`
    - 平文 HTTP
  - 観測:
    - sandbox 内の `NO_PROXY` は
      `localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`
      だった。
    - IP リテラル (`127.0.0.1` と LAN IP) への `curl` は proxy を通らず、0 ms で
      接続に失敗した。
    - ホスト名への `curl` ではリスナーが本物のデコイ値を受け取り、`curl` の出力は
      `ok` だけだった。
- 帰結: README で、`injectHosts` にはホスト名を書くよう案内する。

### F11: HTTPS での差し替えには `network.tlsTerminate` が要る

- D: https://code.claude.com/docs/en/sandboxing#mask-environment-variables
  > Set `network.tlsTerminate` so the proxy terminates TLS itself.
- 実験で確かめていないこと: HTTPS 経路での差し替え。`scan` は送信先を書かない
  (F15) ので、README の案内にだけ関わる。

### F12: 差し替えはヘッダーと本文の両方に効く

- D: https://code.claude.com/docs/en/sandboxing#mask-environment-variables
  > Substitution covers headers and request bodies.
- 推論 (未実験): 次のようなホストを `injectHosts` に含めると、身代わりの値を送る
  だけで本物がエージェントに戻る。README で警告する。
  - 送信した内容を保存し、後で読み出せる API
  - 受け取った内容をそのまま返すホスト

### F13: mask は Linux と WSL2 だけで働く

- D: https://code.claude.com/docs/en/sandboxing#mask-credential-files
  > **macOS**: sandboxed commands can't read the listed file at all.

### F14: `maskDuplicates` は、拾った値のそのままのコピーも置き換える

- D: https://code.claude.com/docs/en/sandboxing#mask-credential-files
  > `maskDuplicates` also replaces verbatim copies of each masked credential
  > value, an `extract` capture or a `decode`-verified token, found outside the
  > matched spans, for a secret repeated where matching doesn't reach. It matches
  > raw substrings, so a short or common value would be replaced everywhere it
  > appears; reserve it for long, high-entropy secrets. Default: false.
- 帰結: 値のすべての箇所で形式を認識する必要は無い。1 箇所で値を拾えれば、
  同じファイル内のそのままのコピーは置き換わる。エンコードされた形は
  「そのままのコピー」ではないので、この仕組みでは拾えない。
- 実験の結果は F16。

### F15: 利用者が書いた `injectHosts: []` は、本物をどこにも送らない

- E4 (`probe empty`、2026-09-15):
  - sandbox 内の `cat` は `api.token=fake_value_<uuid>` を返した。
  - `od -An -c` の出力から空白と改行を除いても、本物の値は現れなかった。
  - `network.allowedDomains` に載せたリスナーに値を送ると、リスナーは身代わりの値
    `fake_value_<uuid>` を受け取った (`injectHosts` は空)。
  - Claude Code は起動時に次の警告を出した。
    > sandbox.credentials mask entries (<path>) have an empty injectHosts —
    > sandboxed commands see only a sentinel and the proxy never substitutes the
    > real credential, so tools needing these will fail to authenticate.
- 間接的な根拠:
  - D (https://code.claude.com/docs/en/claude-apps-gateway#restrict-parent-settings):
    親プロセスから渡された mask は `injectHosts` を空にして転送され、
    "the proxy never substitutes the real value" と書かれている。
  - B: `forwards sentinel-only (injectHosts forced empty)`
- 帰結: `scan` が書いたエントリは、利用者が `injectHosts` を足すまで、Claude Code の
  起動のたびに上の警告を出す。`scan` の注意表示と README で、この警告が出ることと
  その意味を案内する。

### F16: `maskDuplicates: true` は、一致区間の外にあるコピーを同じ身代わりの値にする

- E5 (`probe dup-on` と `probe dup-off`、2026-09-15)
  - ファイル: `db.host=localhost`、`api.token=<値>`、`backup: <値>`、`# old token <値>`
    の 4 行。
  - extract: `api\.token=(\S+)`
  - 観測:
    - `dup-on`: sandbox 内の `cat` で、3 箇所すべてが同じ身代わりの値
      (`fake_value_<同じ uuid>`) になった。`od -An -c` の出力から空白と改行を除いても、
      本物の値は現れなかった。`api.token=` の行から取り出して送った値は、リスナーで
      本物に戻っていた。
    - `dup-off` (対照): `api.token=` だけが身代わりになり、`backup:` とコメントには
      本物の値が残った。
- 実験していないこと:
  - コピーの箇所から取り出した値を送ったときに本物へ戻るか。身代わりの値が
    `api.token=` の箇所と同じ文字列なので、同じく戻ると見込むが、`scan` の安全性には
    関わらない。
  - 重なった出現や、一致区間に接する出現の扱い。設計は、置き換えられると見込む
    コピーを控えめに数える (「安全確認」のコピーの数え方)。

## 背景: 0.1.0 の scan を置き換える理由

以下は設計判断の根拠であり、受け入れ条件ではない。

### G1: denyRead はビルドが読むファイルを守れない

`denyRead` はコマンドを区別しないので、sandbox 内のビルドもファイルを読めなくなる。

`sandbox.excludedCommands` でビルドだけを sandbox の外に出す方法も、成り立たない。

- D: https://code.claude.com/docs/en/settings-reference#sandbox-excludedcommands
  > When any part of a compound command matches an entry, Claude Code runs the
  > whole command unsandboxed.
  >
  > Exclusion is a convenience, not a security boundary
- E2 (コンテナ内で実施。記録用の偽の `bwrap` を PATH に置き、sandbox を通った
  コマンドを記録した。stub の `./gradlew` は引数を echo するだけ)
  - `excludedCommands: ["./gradlew build"]` と `denyRead: ["./decoy.txt"]`:
    - `./gradlew build && cat decoy.txt` は bwrap を経由せずに実行され、
      decoy.txt の中身が出力された。
  - 同じ設定に `permissions.allow: ["Bash(./gradlew build)"]`、
    `--setting-sources project`、`--permission-mode default` を加えた場合:
    - 承認なしで実行された: `./gradlew build && cat decoy.txt`、
      `./gradlew build && base64 notes.txt | base64`、
      `./gradlew build && od -An -c notes.txt`
    - 承認を要求された: `./gradlew build && xxd -p notes.txt`、
      `./gradlew build && gzip -c notes.txt | base64`

### G2: sumi の出力マスクで止まらない加工がある

- E3 (sumi 0.1.0 の `filter` にデコイ値を登録し、加工した出力を通した):

  ```bash
  v=DecoyEncValue-7q3m9x; printf '%s\n' "$v" > s.txt
  printf 'db.password=%s\n' "$v" > f
  od -An -c f | sumi filter --secrets-file s.txt | tr -d ' \n' | grep -c "$v"
  ```

| 加工 | 結果 |
|---|---|
| そのまま、`base64` | マスクされた |
| `base64 \| base64`、`xxd -p`、逆順、`gzip -c \| base64`、`od -An -c` | 元の値に戻せた |

### G3: mask ならビルドはファイルを読める

F3 と E1 のとおり、登録したファイルは sandbox 内で読める。値の部分は身代わりの
値になり、送信先を許可したときだけ本物になる。ファイル自体が読めるので、ビルドが
設定ファイルを読む処理は壊れない。

## CLI

```
sumi scan --agent claude --secrets-file F [--root DIR] [--settings FILE]
```

- `--secrets-file F`: `init` と同じ secrets ファイル。読み込み時に展開したパターン
  (平文、URL エンコード版、base64 版) をすべて使う。
- `--root DIR`: 走査の起点。省略時はカレントディレクトリ。`realpath` で解決する。
- `--settings FILE`: 書き込み先。
  - 省略時は `$CLAUDE_CONFIG_DIR/settings.json`、環境変数が無ければ
    `~/.claude/settings.json` (`init` と同じ決め方)。
  - 次をすべて満たす場合は、エラー (終了コード 1) で止める (F1)。
    - 書き込み先の親ディレクトリを `realpath` で解決した結果、basename が `.claude`
    - そのディレクトリがユーザー設定のディレクトリ (上の既定値の親) と一致しない

## 走査と振り分け

1. `--root` 以下を再帰的にたどる。
   - 名前が `.git` のディレクトリには入らない。
   - シンボリックリンクはたどらない。
   - 通常ファイル以外は対象にしない。
   - 読めないファイルとディレクトリは数えて警告する (終了コード 1)。
2. secrets ファイル自体は対象にしない。0.1.0 と同じく、sumi がそのファイルを
   読むためである。secrets ファイルを sandbox 内から読まれる問題は、この設計の範囲外
   である (`docs/todo/sumi.md` の 1)。
3. 各ファイルについて、展開したパターンのどれかが含まれるかを判定する。
   含まれなければ何もしない。
4. 含まれるファイルについて、次の順に判定する。当たったら「書かない」とし、
   理由コードを付ける。
   - `glob-chars`: 絶対パスに `* ? [ ] { } \` のいずれかを含む (F7)
   - `too-large`: 8 MiB (8 × 1024 × 1024 バイト) を超える (F7)
   - `not-utf8`: UTF-8 として不正 (F7)
   - 以降の理由コードは、次節の extract の生成で決まる
5. extract の生成に成功したファイルは、次々節の規則で設定に反映する。

## extract の生成規則

入力は、ファイルの中身 C (バイト列) と、展開したパターンの集合 P である。
ファイル単位で「全部書く」か「書かない」かを決め、一部の箇所だけを守る
エントリは作らない。

方針は、秘密の位置を見つけた後に、その位置が少数の明示的な抽出形式のどれの値に
当たるかを認識することである。形式ごとに値の範囲と文字の集合を持ち、別の行の
書き方が他の行の判定に影響しないようにする。

### 箇所

P の各パターン p について、C 内のすべての出現位置 (重なりを含む) を集め、
区間 `[i, i + len(p))` の集合 O とする。平文と、エンコードされた形を区別しない。

### ファイル全体が 1 つの値の場合

C の末尾から改行 (`\n` または `\r\n`) を 1 つだけ取り除いた結果が P のいずれかと
完全に等しければ、`extract` を持たないエントリを書く (F3 の 2 つ目の引用)。
以降の手順は行わない。

### 共通の字句

- 空白: SP と HT。行の区切りは LF (直前の CR は行の一部として扱わない)。
- キー文字: `A-Z a-z 0-9 _ . - / :`
- キー: キー文字が 2 文字以上続く列。キーの直前は次のいずれかでなければならない
  (境界)。
  - 行頭
  - 空白
  - `{`、`,`、`;`
  - 引用符で囲まれたキーの場合は、その開き引用符
- 区切り (代入): `=` または `:`。前後に空白を 0 個以上許す。

### 抽出形式

各箇所 s について、次の形式を上から順に試し、s が値の範囲に完全に含まれる最初の
形式を採る。

- 形式に当たらない箇所があってもよい。そうした箇所は、形式に当たった箇所の値の
  そのままのコピーであれば `maskDuplicates` で置き換わる (F14)。可否は「安全確認」の
  拾い漏れの判定で決まる。
- 形式に当たる箇所が 1 つも無ければ、ファイル全体を `no-form` で書かない。

| 形式 | 行の形 | 値の範囲 | 値の文字の集合 |
|---|---|---|---|
| `dq` 二重引用符の代入 | `[境界]["]キー["] 空白* 区切り 空白* "値"` | 開き `"` の直後から、次の `"` の直前まで | `[^"\r\n]` |
| `sq` 一重引用符の代入 | 同上で値の引用符が `'` | 開き `'` の直後から、次の `'` の直前まで | `[^'\r\n]` |
| `bare` 引用符なしの代入 | `[境界][引用符]キー[引用符] 空白* 区切り 空白* 値` | 区切りの後の空白を除いた位置から、次の空白・CR・LF・ファイル末尾の直前まで | `[^ \t\r\n]` |
| `ws` 空白区切り | `[境界]キー 空白+ 値` | キーの後の空白を除いた位置から、次の空白・CR・LF・ファイル末尾の直前まで | `[^ \t\r\n]` |

補足:

- `dq` と `sq` は、閉じ引用符が同じ行に無ければ当たらない。値に同じ引用符が
  含まれる場合 (JSON の `\"` を含む値など) も当たらない。
- `bare` の値の範囲は値の全体である。値が URL (`postgres://app:X@db`) や、秘密の
  base64 を途中に含む長い文字列でも、値全体を拾う。値全体が身代わりになるので、
  そのファイルを読むツールはその値を使えなくなる。安全性には影響しない。値の一部
  (URL のパスワード部分など) だけを拾う形式は、必要性と根拠が揃ってから追加する。
- `ws` は `.netrc` の `password X` や `Authorization: Basic X` の `Basic X` を
  扱う。`bare` に当たらなかった箇所だけに試す。

### 前置き

各箇所で認識した形式から、前置きの文字列 Pk を作る。

| 部品 | 文字列 |
|---|---|
| 境界 | `(?<![A-Za-z0-9_.\-/:])` |
| キー (引用符を含む) | エスケープした文字列 |
| 区切りの左 | `[ \t]*` (`ws` では省略) |
| 区切り | `=` か `:`。`ws` では `[ \t]+` |
| 区切りの右 | `[ \t]*` (`ws` では省略) |
| 値の開き引用符 | `dq` では `"`、`sq` では `'`、それ以外は無し |

- エスケープの対象は `\ ^ $ . | ? * + ( ) [ ] { } /` とする。
- 境界の否定後読みは、長さ 1 の固定長である。
- 例: `api.token = X` の前置きは `(?<![A-Za-z0-9_.\-/:])api\.token[ \t]*=[ \t]*`
  になる。

### 1 つの extract にまとめる

- 前置きを重複除去した集合を `P1 … Pn` とする。並び順は、形式の順
  (`dq`、`sq`、`bare`、`ws`)、同じ形式の中ではファイル内で最初に現れた順とする。
  JavaScript は選択肢を左から試すので、順序は結果に影響する。例えば `K="X"` の行で
  `bare` の前置き `K[ \t]*=[ \t]*` を `dq` の前置きより先に置くと、引用符を含む
  `"X"` が値として拾われる。拾い漏れにはならないが、引用符まで身代わりになり、照合器と
  JavaScript で順序が揃っている必要がある。
- ファイルに現れた形式ごとに、値の選択肢を 1 つずつ作る。

| 形式 | 値の選択肢 |
|---|---|
| `dq` | `(?<=")[^"\r\n]+` |
| `sq` | `(?<=')[^'\r\n]+` |
| `bare` または `ws` | `(?<!["'])[^ \t\r\n]+` |

- extract は `(?:P1|…|Pn)(A1|…|Am)` になる。`A1 … Am` は、現れた形式の値の選択肢を
  上の表の順に並べたものである。n = 1 のときは `(?:…)` を省いて `P1(A1|…|Am)`、
  m = 1 のときは `(A1)` とする。
- 置き換わるのはグループ 1 だけ (F3) なので、形式ごとの値の選択肢は 1 つのグループの
  中にまとめる。どの選択肢が使われるかは、値の直前の 1 文字 (前置きの末尾) で
  固定長の後読みによって決まる。
- 別の行の書き方は、その行の形式の値の選択肢を足すだけで、他の行の値の文字の集合を
  変えない。例えば次の 2 行は、`API_KEY` が `dq`、`PASSWORD` が `sq` として両方
  登録できる。

  ```
  API_KEY="DecoyToken9"
  PASSWORD='DecoyPass"7'
  ```

### 安全確認

生成した extract は、次をすべて満たすときだけ書く。

1. **値そのものを含まない:** extract の文字列が、P のどのパターンも部分文字列として
   含まない。満たさなければ `prefix-contains-value` で書かない。
2. **拾い漏れがない:** sumi の照合器で extract を C に適用し、グループ 1 の区間の
   集合 G を得る。
   - O のすべての区間 s について、s ⊆ g を満たす g ∈ G が存在すれば、
     `maskDuplicates` を付けずに書く。
   - そうでなければ、G の各区間の文字列のそのままのコピーの区間の集合 D を、下の
     「コピーの数え方」で求める。O のすべての区間 s が G ∪ D のいずれかに含まれれば、
     `maskDuplicates: true` を付けて書く。
   - それでも含まれない区間があれば、`coverage` で書かない。例えば、秘密が別の箇所に
     エンコードされた形で現れ、その形がどの形式にも当たらない場合である。
   - G が O に対応しない区間を含むことは許す (例: `# api.token=old` のような
     コメント、同じキーが別の形式で書かれた行)。身代わりの値が増えるだけで、
     安全側だからである。

コピーの数え方は、Claude Code が少なくともこれだけは置き換えると見込める下限とする。
本物の挙動がこれより多く置き換えても、安全側になる。

- G の区間の文字列 (重複除去) ごとに、C を左から走査する。
- G のどの区間とも重ならない出現だけを数え、数えたら、その出現の末尾から次を探す
  (重ならない出現だけを数える)。
- 本物の挙動は、一致区間の外にあるコピーを同じ身代わりの値にする (F16)。この下限は
  E5 で観測した置き換えに含まれる。重なった出現の扱いは実験していないので、数えない。

照合器の仕様は次のとおり。

- 対象は、上の生成規則が作る形だけである。任意の正規表現は扱わない。
  - 前置きの選択肢
  - 固定長 1 の肯定・否定の後読み
  - 除外文字の集合の 1 回以上の繰り返し
  - 値の選択肢
- extract の文字列と照合器の入力は、同じ中間表現から作る。文字列を解析し直さない。
- JavaScript の `String.prototype.replace` を `g` フラグ付きで使ったときと同じ区間を
  返す。
  - 位置 0 から最も左の一致を探し、一致の末尾から次の探索を始める。
  - 選択肢は左から順に試し、最初に一致全体が成立したものを採る。
  - 繰り返しは最長一致とし、後続が無いのでバックトラックは起きない。

### エントリの固定値

```json
{
  "path": "<realpath による絶対パス>",
  "mode": "mask",
  "extract": "<生成した文字列>",
  "injectHosts": [],
  "onExtractNoMatch": "deny"
}
```

- `extract` はファイル全体が 1 つの値の場合だけ省略する。
- `maskDuplicates` は、拾い漏れの判定でコピーが必要になったときだけ `true` で書き、
  それ以外では書かない。
  - ドキュメントは短い値や一般的な値について注意している (F14)。ただし mask は
    エントリのファイル 1 つだけに適用されるので、置き換えが増える範囲はそのファイル内に
    限られる。
  - 必要なときだけ付けることで、置き換えが増える範囲をさらに狭める。
- `injectHosts: []` は、本物をどこにも送らないために書く (F15)。

## 設定ファイルへの反映

### 読み込み

- 書き込み先を JSON として読む。ファイルが無ければ `{}` から始める。
- 次に当たったら、何も書かずに終了コード 1 で止める。
  - 最上位がオブジェクトでない
  - `sandbox` がオブジェクトでない
  - `sandbox.credentials` がオブジェクトでない
  - `sandbox.credentials.files` が配列でない
  - `files` の要素にオブジェクトでないもの、または `path` が文字列でないものがある
  - `sandbox.filesystem.denyRead` が文字列の配列でない
- 深さの上限は既存の `jsonio.parse` に従う。

### 所有の記録

- 記録ファイルは `<書き込み先から末尾の .json を除いたもの>.sumi-scan.json` とする。
  内容は `{"credentialsFiles": ["<絶対パス>", …]}` で、sumi が書いたエントリの
  `path` を列挙する。
- エントリ自体に目印のフィールドは足さない (U6)。
- 記録ファイルが不正な JSON の場合は、何も書かずに終了コード 1 で止める。

### ファイルごとの動作

以下の「root 配下」は、絶対パスが `<root>/` で始まることを指す。

| # | 状況 | 動作 | 表示 |
|---|---|---|---|
| 1 | root 配下の値を含むファイル。extract を作れ、同じ `path` のエントリが無い | エントリを追加し、記録に載せる | `mask <path>` |
| 2 | 1 と同じだが、sumi が書いたエントリがある | `mode`、`extract`、`onExtractNoMatch` を生成値で上書きする。`injectHosts` を含むその他のフィールドは残す | `mask <path>` |
| 3 | root 配下の値を含むファイル。同じ `path` に、sumi が書いたのではないエントリがある | 触らない | `skip <path>: existing-entry` |
| 4 | root 配下の値を含むファイル。同じ設定ファイルの `denyRead` に、その絶対パスがそのまま載っている | 書かない | `skip <path>: denyread-conflict` |
| 5 | root 配下の値を含むファイル。extract を作れず、sumi が書いたエントリも無い | 書かない | `skip <path>: <理由コード>` |
| 6 | sumi が書いた root 配下のエントリ。ファイルが無い、または値を含まない | エントリを削除し、記録から外す | `unmask <path>` |
| 7 | sumi が書いた root 配下のエントリ。ファイルは値を含むが、今回は書けない (5 に当たる) | エントリを削除し、記録から外す。終了コードを 1 にする | `unmask <path>: was masked, now <理由コード>` |
| 8 | sumi が書いた root 配下以外のエントリ | 残し、記録にも残す | なし |
| 9 | sumi が書いたのではない root 配下以外のエントリ | 触らない | なし |

表の補足:

- 3 と 4 は、利用者の設定を優先する (F9 と U3)。
- 7 でエントリを削除する理由: 古い extract を残すと、新しい箇所を拾えないまま
  一部だけ守られた状態になり、気付けない。削除するとそのファイルは平文で読める
  ようになるので、終了コードで知らせる。

### 書き込み

- 生成した JSON が元の内容と同じなら、設定ファイルも記録ファイルもバックアップも
  書かない。
- 異なる場合は、次の順に書く。
  1. `init` と同じ形式 (`<書き込み先>.bak.<YYYYmmddHHMMSS>`、mode 0600) で
     バックアップを取る。
  2. 設定ファイルを書く。
  3. 記録ファイルを書く。

### 注意表示

次の場合に `sumi: note:` の行を出す。

- 書き込み先の `sandbox.enabled` が `true` でない。
- 1 件以上 mask した。このとき、次の内容を表示する。
  - `injectHosts` が空なので、本物はどこにも送られないこと
  - 送信を許すには、`injectHosts` と `network.allowedDomains` にホスト名を足し、
    HTTPS なら `network.tlsTerminate` も設定すること
  - 足すまでは、Claude Code が起動のたびに empty injectHosts の警告を出すこと (F15)
- 見えるのは書き込み先の設定ファイルだけであること。README にも書く。

## 表示と終了コード

- 表示は stderr に出す。1 行に 1 ファイルで、上の表の形式に従う。最後に件数の要約
  (`N masked, N unmasked, N skipped in <path>`) を出す。
- **値、extract の文字列、前置き、キーは表示しない。** 表示してよいのは、パス、
  理由コード、件数だけである。
- 理由コード: `glob-chars`、`too-large`、`not-utf8`、`no-form`、
  `prefix-contains-value`、`coverage`、`existing-entry`、`denyread-conflict`

| 状況 | 終了コード |
|---|---|
| 正常終了 (skip を含む) | 0 |
| 読めないファイルがある、表の 7 に当たるファイルがある、設定ファイルまたは記録ファイルが不正、書き込み先が拒否対象 | 1 |
| 引数の誤り | 2 |

## 平文の置き場所

既存の設計 (`docs/superpowers/specs/2026-09-11-sumi-single-binary-design.md`) の
「平文が置かれる場所は secrets ファイルと各プロセスのメモリだけ」を維持する。

`scan` が書く設定ファイル、記録ファイル、バックアップ、表示は、`scan` が値や展開した
パターンを入れることはない。ただしバックアップは元の設定ファイルの複製なので、
利用者が元の設定ファイルに値を書いていた場合は、それを含む。

## コード構成

```
contrib/sumi/
  claude/scan.zig      # CLI、走査、振り分け、設定と記録の読み書き (作り直し)
  claude/extract.zig   # 抽出形式の認識、中間表現、文字列化、照合器、安全確認 (新規)
  tests/run-tests.sh   # scan の黒箱テストを差し替え
  tests/extract-parity.ts  # bun で JS の RegExp と照合器の結果を比べる (新規)
  README.md、CHANGELOG.md
```

- 0.1.0 の `denyRead` の書き込み、相対パス化、プロジェクト設定用の記録ファイルの
  処理と、そのテストを削除する。
- `src/zig/mask.zig` は変更しない。箇所の位置は `std.mem.indexOfPos` の繰り返しで
  集める。対象は 8 MiB 以下のファイルに限られる。
- `extract.zig` は Claude Code の正規表現の扱い (F3 から F5) に依存するので、
  `claude/` に置く。

## 未確認事項

### U1: 解決済み

利用者が書いた `injectHosts: []` の意味は、実験で確かめた (F15)。

### U2: 固定長の後読みを含む extract が Claude Code の実行環境で動く

- 根拠: extract は `new RegExp` で扱われる (F4)。後読みは ECMAScript 2018 の仕様に
  含まれ、bun で動作を確かめた。Claude Code の実行環境で動くかは確かめていない。
- 確かめる方法: 受け入れ条件のホスト検証で、`dq` と `sq` と `bare` を含むファイルを
  登録し、sandbox 内の `cat` ですべての値が身代わりになることを確かめる。
- 結果が異なる場合は、設計を見直す。後読みは境界と値の選択肢の両方で使っている。

### U3: `denyRead` に同じパスがある場合も mask が捨てられるか

- 設計は、捨てられる前提で書かない (表の 4)。捨てられないと分かっても、安全性には
  影響しない。

### U4: 同じ `path` のエントリが複数あるときの扱い

- 設計は同じ `path` を 2 つ書かない (表の 1 から 3)。

### U5: HTTPS での差し替え

- `scan` は送信先を書かないので、README の案内の正確さにだけ関わる。

### U6: エントリの未知のフィールドの扱い

- 設計は未知のフィールドを足さない。記録ファイルで所有を管理する。

### U7: extract に付くフラグ

- 設計はフラグで意味の変わる構文を使わない (F5)。

### U8: 解決済み

`maskDuplicates` の置き換えは、実験で確かめた (F16)。

## 検証と受け入れ条件

### 単体テスト (`zig build test`)

- **抽出形式と extract:** 次の入力ごとに、認識する形式と生成される extract の
  文字列が期待値と一致する。
  - properties: `a.b=X`、`a.b = X` (`bare`)
  - `.env`: `API_KEY=X` (`bare`)、`API_KEY="X"` (`dq`)、`API_KEY='X'` (`sq`)
  - `.env` の混在: `API_KEY="DecoyToken9"` と `PASSWORD='DecoyPass"7'` の 2 行。
    両方が登録される
  - JSON: 複数行の `"password": "X"`、1 行の `{"user":"app","password":"X"}` (`dq`)
  - YAML: `  token: X` (`bare`)
  - `.npmrc`: `//registry.npmjs.org/:_authToken=X` (`bare`)
  - `.netrc`: `machine h login u password X` (`ws`)
  - `Authorization: Basic <base64(user:X)>` (`ws`、値全体を拾う)
  - `DATABASE_URL=postgres://app:X@db` (`bare`、値全体を拾う)
  - 秘密の base64 が途中に埋め込まれた `k=<長い base64>` (`bare`、値全体を拾う)
- **重複のコピー:**
  - `foo=X` と `bar X Y` (形式に当たらない位置の X) と `# X` の 3 行で、`foo` だけの
    extract と `maskDuplicates: true` が生成される。
  - 形式に当たる箇所だけでグループ 1 が全箇所を覆う入力では、`maskDuplicates` が
    書かれない。
  - `k=X` と、X の base64 が形式に当たらない位置にあるファイルは `coverage` になる
    (エンコードされた形はコピーではない)。
  - `k=abXab` の値全体 `abXab` を拾ったとき、別の行の単独の `X` はコピーに数えない
    (`coverage`)。
- **理由コード:** 次の各入力で、期待する理由コードを返す。
  - `no-form`: 形式に当たる箇所が 1 つも無い (行頭の値だけ、1 文字のキーだけ、
    閉じ引用符が無い `dq` だけ、値に同じ引用符を含む `dq` だけ)
  - `prefix-contains-value`: 前置き (キー) に別の値を含む
  - `coverage`: 照合器が拾えない箇所を人工的に作る
  - ファイル全体が値の場合に extract を省略する
- **照合器:**
  - 位置 0 から最も左の一致を探し、一致の末尾から次を探す
  - 前置きの選択肢と値の選択肢の順序
  - 固定長の後読み
  - 余分な一致を許す
  - 区間の包含判定
  - コピーの数え方 (G と重なる出現を数えない、重ならない出現だけを数える)
- **設定の反映:** 表の 1 から 9 の各行と、「読み込み」の各不正入力。
- **CLI:** 書き込み先の拒否 (プロジェクトの `.claude/`)。

### JS との整合 (`tests/extract-parity.ts`、`run-tests.sh` から実行)

- 単体テストと同じ入力について、sumi が書いた extract を
  `new RegExp(extract, "g")` として JavaScript の `replace` に通し、グループ 1 の区間を
  `SENTINEL` に置き換える。
- 次の 2 つを確かめる。
  - 置き換えた結果に、展開したどのパターンも残らない。
  - グループ 1 の区間が、sumi の照合器の結果と一致する。
- `maskDuplicates` の置き換えは Claude Code の機能なので、この試験の対象外である。
  JavaScript の置き換えの後に、sumi の「コピーの数え方」で求めた区間も
  `SENTINEL` にしてから、値が残らないことを確かめる。コピーの挙動そのものは、
  F16 で確かめた。
- bun が無い環境では `skip` と表示し、失敗にしない。CI (`nix develop`) には bun がある。

### 黒箱テスト (`tests/run-tests.sh`)

デコイ値だけを使い、書き込み先は一時ファイルとする。

- エントリの形 (絶対パス、`mask`、`injectHosts: []`、`onExtractNoMatch: "deny"`、
  値だけのファイルで extract が無い) が期待どおり。
- 設定ファイル、記録ファイル、stdout、stderr のいずれにも、デコイ値と、その
  URL エンコード版・base64 版が現れない (grep で確かめる)。
- 表の 2: 利用者が足した `injectHosts: ["example.com"]` が再実行後も残る。
- 表の 3、4、6、7、8 の動作と表示。7 は終了コード 1。
- 変更の無い再実行で、バックアップが増えない。
- `--settings <root>/.claude/settings.local.json` は終了コード 1 で、何も書かない。

### ホストでの検証 (`tests/manual-validation.md` と `validation-results.md` に追記)

- F15 と F16 の実験 (`probe empty`、`dup-on`、`dup-off`) の結果を記録する。
- `sumi scan` が生成した設定を `claude --settings` で使い、次を記録する。
  - `dq`、`sq`、`bare` を含む `.env` と、JSON のファイルで、sandbox 内の `cat` と
    `od -An -c` に本物の値が現れない (U2)。
  - 値を含まない行 (`db.host=localhost` など) はそのまま読める。

## Why — なぜこのアプローチを選んだか

- **ビルドを壊さずに、sandbox 内のあらゆる読み方から値を隠せる。**
  - 登録したファイルは読めるまま、値の部分だけが身代わりになる (F3、G3)。
  - ファイルの中身そのものが置き換わるので、G2 の加工 (2 重 base64、`od -c` など) も
    意味を持たない (E1)。
  - denyRead (G1) と sumi の出力マスク (G2) のどちらでも守れなかった「ビルドは
    読むがエージェントには見せたくない値」を、Claude Code 自身の仕組みで守れる。
- **秘密の位置を見つけてから、少数の明示的な抽出形式を認識する。**
  - 形式ごとに値の範囲と文字の集合が決まるので、別の行の書き方が他の行の判定に
    影響しない。
  - 対応形式を増やすときは、形式を 1 つ足すだけで済み、既存の形式の規則を変えない。
- **前置きは非キャプチャの選択肢にし、後読みは固定長だけにする。**
  - 置き換わるのはグループ 1 だけなので、前置きを一致に含めても結果は同じである (F3)。
  - 長さの違う選択肢を持つ後読みが要らなくなり、照合器が扱う構文も減る。
- **正規表現の形を限定し、sumi 自身が同じ規則で照合する。**
  - 単一バイナリの配布方針を保ったまま、書き込む extract がすべての箇所を拾うことを
    書き込み前に確かめられる。
  - 照合器が JavaScript とずれる危険は、JS との整合テストで塞ぐ。
- **1 箇所で値を拾えれば、残りのそのままのコピーは `maskDuplicates` に任せる。**
  - すべての箇所でキーを認識しなくてよいので、形式に当たらない書き方
    (`bar X Y` のような位置、コメント) が同じファイルにあっても登録できる。
  - 拾えるかどうかは、控えめに見積もったコピーの区間を含めて照合器で確かめる。
    本物の挙動が見積もりより多く置き換えても、安全側になる。
- **エンコードされた値も、1 つの秘密として扱う。**
  - プロキシは、グループ 1 が拾った文字列そのものを戻して送る。平文とエンコード済みを
    区別する理由が無い。
  - 値全体を拾えば、sumi の出力マスクでは隠しきれない境界のビットも隠れる。
- **`injectHosts: []` で書き、送信先は利用者が足す。**
  - どこへ送ってよいかは `scan` には分からない。
  - 書いた直後の状態を「本物がどこにも出ない」にしておけば、`scan` の実行で
    漏れる経路は増えない。
- **書けないファイルは書かずに表示する。**
  - deny に倒すと、ビルドが読むファイルでビルドが壊れる (G1)。
  - どう守るかは利用者が判断する。

## Why Not — なぜ他の案を選ばなかったか

- **0.1.0 のまま denyRead を書く**: ビルドが読むファイルではビルドが壊れる。
  `excludedCommands` でビルドを外に出すと、複合コマンドで全ファイルの保護が失われる (G1)。
- **mask にできないファイルは deny で書く**: ビルドが読むファイルで、利用者の知らない
  うちにビルドが壊れる。
- **候補を表示するだけで設定には書かない**: 利用者が extract を手で写す手間と誤りが
  増える。`injectHosts: []` で書けば、書くこと自体は安全側に倒せる。
- **自由な正規表現を作り、bun や node で検証する**: 利用者の環境に JavaScript の
  実行環境を要求し、「1 ファイル落とすだけ」の配布方針を崩す。
- **extract を使わず、ファイル全体を身代わりにするだけ**: 構造のあるファイルを
  パースできなくなり、ビルドが壊れる。値だけのファイルの特例としてだけ採る。
- **前置きが複数あるときに可変長の後読み `(?<=P1|P2)(値)` にする**: `(?:P1|P2)(値)` と
  置き換える区間は変わらず (F3)、生成の分岐と照合器の可変長後読みの処理が増えるだけ
  である。
- **共通のトークン規則と、ファイル全体で合成した除外文字の集合で値を切り出す**:
  別の行の書き方が他の行の値の文字の集合を変え、例えば `API_KEY="…"` の行があるだけで
  `PASSWORD='…"…'` の行を登録できなくなる。base64 や URL の都合も共通規則に積み重なる。
- **URL の認証情報部分や、埋め込み base64 の一部だけを最初から拾う**: 形式が増え、
  根拠の無い規則が入る。値全体を拾っても安全性は保たれるので、必要性と根拠が揃って
  から形式を足す。
- **エンコードされた値が含まれるファイルを書かない**: 平文と同じ規則で拾え、
  プロキシも拾った文字列そのものを戻すので、除外する理由が無い。
- **すべての箇所で形式を認識できないファイルを書かない**: 1 箇所で値を拾えれば、
  そのままのコピーは `maskDuplicates` で置き換わる (F14)。形式を認識できない書き方が
  1 行あるだけで、ファイル全体を登録できなくなる。
- **常に `maskDuplicates: true` を付ける**: ドキュメントは短い値や一般的な値で
  置き換えが広がると注意している (F14)。必要なときだけ付ければ、判定が同じまま、
  置き換えの広がりを抑えられる。
- **走査の速度改善を同時に行う**: `src/zig/mask.zig` は nas と共有しており、影響の
  検証が別に要る。この設計の正しさとは独立しているので、別の設計にする。
