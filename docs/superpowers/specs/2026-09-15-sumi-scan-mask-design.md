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
含めない。`src/zig/mask.zig` は nas と共有しているので、別の設計で扱う。

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
  `docs/superpowers/probes/2026-09-15-sumi-credential-mask-probe.sh [listed|empty|omitted]`
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
  (U1) ので、README の案内にだけ関わる。

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
   読むためである。
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

### 箇所

P の各パターン p について、C 内のすべての出現位置 (重なりを含む) を集め、
区間 `[i, i + len(p))` の集合 O とする。平文と、エンコードされた形を区別しない。

### ファイル全体が 1 つの値の場合

C の末尾から改行 (`\n` または `\r\n`) を 1 つだけ取り除いた結果が P のいずれかと
完全に等しければ、`extract` を持たないエントリを書く (F3 の 2 つ目の引用)。
以降の手順は行わない。

### トークン

O の各区間 s について、s を含む「値のトークン」T = `[tl, tr)` を次のように決める。

- 左端: s の先頭から左へ、次の文字の直前まで伸ばす。
  - 文字: 空白 (SP、HT、CR、LF)、`"`、`'`、`=`、`:`、`@`、`,`、`;`、`(`、
    `[`、`{`、`<`、`>`
  - `/` は含めない。base64 に `/` が現れるためである。
- 右端: s の末尾から右へ、次の文字の直前まで伸ばす。
  - 文字: 空白、`"`、`'`、`&`、`,`、`;`、`@`、`<`、`>`、`)`、`]`、`}`
  - `=` は含めない。base64 の末尾の `=` をトークンに含めるためである。
- 終わりの文字 t: C[tr]。tr がファイル末尾なら「無し」とする。

同じ T を持つ区間は 1 つにまとめる。

### キーと前置き

各トークン T について、tl から左へ同じ行の中を読み、次の形を認識する。

```
[境界][キーの引用符?][キー][キーの引用符?][空白*][区切り][空白*][値の開き引用符?] T
```

1. 値の開き引用符: C[tl-1] が `"` または `'` なら、その文字。
2. 区切りの右の空白: SP または HT の連続 (0 個以上)。
3. 区切り: 次のどちらか。
   - `=` または `:`
   - 空白 (SP または HT が 1 個以上あり、その左がキー文字): `.netrc` の
     `password X` のような形
4. 区切りの左の空白: SP または HT の連続 (0 個以上)。区切りが空白のときは無い。
5. キーの引用符: `"` または `'`。あれば、キーの左にも同じ文字が要る。
6. キー: キー文字 `A-Z a-z 0-9 _ . - / : @` が 2 文字以上続く部分。

途中で形が合わない場合、またはキーが 2 文字未満の場合は、ファイル全体を
`no-key` で書かない。

前置き Pk は、次の部品をこの順に連結した正規表現の文字列とする。

| 部品 | 文字列 |
|---|---|
| 境界 | `(?<![A-Za-z0-9_.-])` |
| キー (引用符を含む) | エスケープした文字列 |
| 区切りの左 | `[ \t]*` (区切りが空白のときは省略) |
| 区切り | `=` または `:`。空白のときは `[ \t]+` |
| 区切りの右 | `[ \t]*` (区切りが空白のときは省略) |
| 値の開き引用符 | その文字 |

- エスケープの対象は `\ ^ $ . | ? * + ( ) [ ] { } /` とする。
- 例: `api.token = X` の前置きは `(?<![A-Za-z0-9_.-])api\.token[ \t]*=[ \t]*` になる。

### 値の部分

1. 除外文字の集合 E を、SP、HT、CR、LF と、全トークンの終わりの文字
   (「無し」と空白を除く) の和とする。
2. どれかのトークンが E の文字を含む場合は、ファイル全体を
   `value-contains-delimiter` で書かない。
3. 値の部分 V は `([^<E を列挙し、\ ] ^ - をエスケープしたもの>]+)` とする。
   - 例: E が SP、HT、CR、LF、`"` なら `([^ \t\r\n"]+)` になる。

### 1 つの extract にまとめる

- 前置きを重複除去した集合を `P1 … Pn` とする。
- n = 1 のとき、extract は `P1 V` になる。
- n ≥ 2 のとき、extract は `(?<=P1|P2|…|Pn) V` になる。JavaScript の後読みは
  長さの違う選択肢を許す。Claude Code の実行環境で動くかは U2 で確かめる。

### 安全確認

生成した extract は、次をすべて満たすときだけ書く。

1. **値そのものを含まない:** extract の文字列が、P のどのパターンも部分文字列として
   含まない。満たさなければ `prefix-contains-value` で書かない。
2. **拾い漏れがない:** sumi の照合器で extract を C に適用し、グループ 1 の区間の
   集合 G を得る。O のすべての区間 s について、s ⊆ g を満たす g ∈ G が存在する。
   満たさなければ `coverage` で書かない。
   - G が O に対応しない区間を含むことは許す (例: `# api.token=old` のような
     コメント)。身代わりの値が増えるだけで、安全側だからである。

照合器の仕様は次のとおり。

- 対象は、上の生成規則が作る形 (部品の連結、後読みの選択肢、除外文字の集合) だけ
  である。任意の正規表現は扱わない。
- extract の文字列と照合器の入力は、同じ中間表現から作る。文字列を解析し直さない。
- JavaScript の `String.prototype.replace` を `g` フラグ付きで使ったときと同じ区間を
  返す。すなわち、位置 0 から最も左の一致を探し、一致の末尾から次の探索を始める。
- この形では各部品の一致が一意に決まるので、バックトラックは要らない。
- 後読みの判定は、その位置で終わる選択肢が 1 つでもあるかどうかで行う。

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
- `maskDuplicates` は書かない。前置きの無い場所にある値は `no-key` で書かないので、
  重複の置き換えに頼る場面が無いためである。
- `injectHosts: []` は、本物をどこにも送らない意図で書く。この意味は U1 で確かめる。

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
- 見えるのは書き込み先の設定ファイルだけであること。README にも書く。

## 表示と終了コード

- 表示は stderr に出す。1 行に 1 ファイルで、上の表の形式に従う。最後に件数の要約
  (`N masked, N unmasked, N skipped in <path>`) を出す。
- **値、extract の文字列、トークン、前置きは表示しない。** 表示してよいのは、パス、
  理由コード、件数だけである。
- 理由コード: `glob-chars`、`too-large`、`not-utf8`、`no-key`、
  `value-contains-delimiter`、`prefix-contains-value`、`coverage`、`existing-entry`、
  `denyread-conflict`

| 状況 | 終了コード |
|---|---|
| 正常終了 (skip を含む) | 0 |
| 読めないファイルがある、表の 7 に当たるファイルがある、設定ファイルまたは記録ファイルが不正、書き込み先が拒否対象 | 1 |
| 引数の誤り | 2 |

## 平文の置き場所

既存の設計 (`docs/superpowers/specs/2026-09-11-sumi-single-binary-design.md`) の
「平文が置かれる場所は secrets ファイルと各プロセスのメモリだけ」を維持する。

`scan` が書く設定ファイル、記録ファイル、バックアップ、表示は、値も、展開した
パターンも含まない。バックアップは元の設定ファイルの複製であり、元の設定ファイルに
利用者が値を書いていた場合は、それを含む。

## コード構成

```
contrib/sumi/
  claude/scan.zig      # CLI、走査、振り分け、設定と記録の読み書き (作り直し)
  claude/extract.zig   # トークンと前置きの認識、中間表現、文字列化、照合器、安全確認 (新規)
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

### U1: 利用者が書いた `injectHosts: []` は、どこにも差し替えない

- 根拠 (間接的なもの):
  - D (https://code.claude.com/docs/en/claude-apps-gateway#restrict-parent-settings):
    > forwarded sentinel-only, as a whole-file mask whose `injectHosts` is the
    > empty list, so the proxy never substitutes the real value for a
    > parent-supplied entry on any platform.
    
    ただし、これは親プロセスから渡された設定についての記述である。
  - B: `forwards sentinel-only (injectHosts forced empty)`。無効化された
    ユーザー設定のための処理にある。
- 確かめる方法: `probe empty` を実行し、リスナーの受信が `not the real value:` で
  始まる (身代わりの値を受け取った) か、`nothing received` であることを確かめる。
- 実装計画の最初の作業とする。結果が `real decoy value (substituted)` なら、
  実装に進まずに設計を見直す。

### U2: 後読みを含む extract が Claude Code の実行環境で動く

- 根拠: extract は `new RegExp` で扱われる (F4)。長さの違う選択肢を持つ後読みは
  ECMAScript 2018 の仕様に含まれ、bun で動作を確かめた。Claude Code の実行環境で
  動くかは確かめていない。
- 確かめる方法: 受け入れ条件のホスト検証で、前置きが 2 種類あるファイルを登録し、
  sandbox 内の `cat` で両方の値が身代わりになることを確かめる。
- 結果が異なる場合は、n ≥ 2 のファイルを `coverage` で書かないように変える。

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

## 検証と受け入れ条件

### 単体テスト (`zig build test`)

- **トークンと前置き:** 次の形式ごとに、生成される extract の文字列が期待値と一致する。
  - properties (`a.b=X`、`a.b = X`)
  - `.env` (`API_KEY=X`、`API_KEY="X"`、`API_KEY='X'`)
  - JSON (`"password": "X"`)
  - YAML (`  token: X`)
  - `.npmrc` (`//registry.npmjs.org/:_authToken=X`)
  - URL (`postgres://app:X@db`)
  - `.netrc` (`password X`)
  - `Authorization: Basic <base64(user:X)>`
  - 値の base64 が別の base64 文字列の途中に埋め込まれた `k=<blob>`
- **理由コード:** 次の各入力で、期待する理由コードを返す。
  - `no-key` (行頭の値、1 文字のキー)
  - `value-contains-delimiter`
  - `prefix-contains-value` (前置きに別の値を含む)
  - `coverage` (照合器が拾えない箇所を人工的に作る)
  - ファイル全体が値の場合に extract を省略する
- **照合器:**
  - 位置 0 から最も左の一致を探し、一致の末尾から次を探す
  - 後読みの選択肢
  - 余分な一致を許す
  - 区間の包含判定
- **設定の反映:** 表の 1 から 9 の各行と、「読み込み」の各不正入力。
- **CLI:** 書き込み先の拒否 (プロジェクトの `.claude/`)。

### JS との整合 (`tests/extract-parity.ts`、`run-tests.sh` から実行)

- 単体テストと同じ入力について、sumi が書いた extract を
  `new RegExp(extract, "g")` として JavaScript の `replace` に通し、グループ 1 の区間を
  `SENTINEL` に置き換える。
- 次の 2 つを確かめる。
  - 置き換えた結果に、展開したどのパターンも残らない。
  - グループ 1 の区間が、sumi の照合器の結果と一致する。
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

- U1 を `probe empty` で確かめ、結果を記録する。
- `sumi scan` が生成した設定を `claude --settings` で使い、次を記録する。
  - properties、JSON、前置き 2 種類のファイル (U2) で、sandbox 内の `cat` と
    `od -An -c` に本物の値が現れない。
  - 値を含まない行 (`db.host=localhost` など) はそのまま読める。

## Why — なぜこのアプローチを選んだか

- **ビルドを壊さずに、sandbox 内のあらゆる読み方から値を隠せる。**
  - 登録したファイルは読めるまま、値の部分だけが身代わりになる (F3、G3)。
  - ファイルの中身そのものが置き換わるので、G2 の加工 (2 重 base64、`od -c` など) も
    意味を持たない (E1)。
  - denyRead (G1) と sumi の出力マスク (G2) のどちらでも守れなかった「ビルドは
    読むがエージェントには見せたくない値」を、Claude Code 自身の仕組みで守れる。
- **正規表現の形を限定し、sumi 自身が同じ規則で照合する。**
  - 単一バイナリの配布方針を保ったまま、書き込む extract がすべての箇所を拾うことを
    書き込み前に確かめられる。
  - 形が限定されているので、照合器はバックトラックの無い小さな実装で済む。
  - 照合器が JavaScript とずれる危険は、JS との整合テストで塞ぐ。
- **エンコードされた値も、1 つの秘密として扱う。**
  - プロキシは、グループ 1 が拾った文字列そのものを戻して送る。平文とエンコード済みを
    区別する理由が無い。
  - base64 の文字列全体を拾えば、sumi の出力マスクでは隠しきれない境界のビットも
    隠れる。
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
- **エンコードされた値が含まれるファイルを書かない**: 平文と同じ規則で拾え、
  プロキシも拾った文字列そのものを戻すので、除外する理由が無い。
- **`maskDuplicates` で前置きの無い値も拾う**: そのままのコピーしか置き換えず、
  エンコードされた形を拾わない。短い値では無関係な箇所まで置き換える (D:
  https://code.claude.com/docs/en/sandboxing#mask-credential-files の
  `maskDuplicates` の説明)。
- **走査の速度改善を同時に行う**: `src/zig/mask.zig` は nas と共有しており、影響の
  検証が別に要る。この設計の正しさとは独立しているので、別の設計にする。
