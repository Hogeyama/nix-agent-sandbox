# sumi credential mask: 仕様の根拠と実験記録

2026-09-15 の設計レビュー時に記録された根拠を保存する。
設計の動作規則は [sumi scan の設計](../specs/2026-09-15-sumi-scan-mask-design.md) を参照する。
この記録の F / E / G の番号は、既存の観測との対応を保つために維持している。
書き直しに伴う新たなホスト実験は行っていない。

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
- **E (実験)**: 実験時の設定と観測結果。ホストでの実験には、bubblewrap が使える環境で
  デコイ値だけを使った。

未実験の挙動は各項で明記する。新しい生成ルールについての検証と、結果が想定と異なる
場合の扱いは、設計本文の受け入れ条件を参照する。

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
- E1（送信先を `injectHosts` に指定）:
  - sandbox 内の `cat app.properties` は `api.token=fake_value_<uuid>` を返し、
    本物の値を含まなかった。
  - `od -An -c app.properties` の出力から空白と改行を除いても、本物の値は
    現れなかった。
- 帰結: 一致全体に前置き (キーと区切り) が含まれても、置き換わるのはグループ 1
  だけである。前置きの可変長後読みを使わずに、捕捉部分だけを置き換えられる。

### F4: extract は JavaScript の `RegExp` として検証され、グループが必須

- D: https://code.claude.com/docs/en/sandboxing#mask-credential-files
  > the pattern must contain at least one capturing group
- B: `o=new RegExp(e)`、`extract must contain at least one capturing group`

### F5: extract はファイル全体に繰り返し適用される。その他のフラグは不明

- B: `Applied globally` (`extract` の説明文)
- 不明な点: `m`、`i`、`s`、`u`、`y` などのフラグが付くかどうか。
- 帰結: 行頭からの照合には `(?:^|\n)` を使い、`m` が無くても2行目以降に一致させる。
  次のものには依存しない。
  - `^` 単独による複数行の照合と `$`
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
- 帰結: `scan` は新規登録で `injectHosts: []` を書く。再生成時の利用者設定の維持は
  設計本文のフィールド管理規則に従う。
- 未確認: `injectHosts` を省略したファイル mask で、許可したホストが本物の値を
  受け取ること（未実験）。

### F9: 同じファイルに credentials の deny があると、mask は捨てられる

- B: `denies the same file`。該当箇所の全文は
  `credential file mask for '${$o.path}' dropped: '${zl}' denies the same file`
  である。
- 帰結: 同じパスに利用者のエントリがあれば、`scan` は触らない。
- 未確認: `sandbox.filesystem.denyRead` に同じパスがある場合にも mask が捨てられるか
  (未実験)。

### F10: 許可したホストへの送信で本物に差し替わる。プライベート IP は proxy を通らない

- E1（送信先を `injectHosts` に指定）
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

- E4（`injectHosts: []`、2026-09-15）:
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

- E5（`maskDuplicates: true` と `false` の比較、2026-09-15）
  - ファイル: `db.host=localhost`、`api.token=<値>`、`backup: <値>`、`# old token <値>`
    の 4 行。
  - extract: `api\.token=(\S+)`
  - 観測:
    - `maskDuplicates: true`: sandbox 内の `cat` で、3 箇所すべてが同じ身代わりの値
      (`fake_value_<同じ uuid>`) になった。`od -An -c` の出力から空白と改行を除いても、
      本物の値は現れなかった。`api.token=` の行から取り出して送った値は、リスナーで
      本物に戻っていた。
    - `maskDuplicates: false`（対照）: `api.token=` だけが身代わりになり、`backup:` とコメントには
      本物の値が残った。
- 実験していないこと:
  - コピーの箇所から取り出した値を送ったときに本物へ戻るか。身代わりの値が
    `api.token=` の箇所と同じ文字列なので、同じく戻ると見込むが、`scan` の安全性には
    関わらない。
  - 重なった出現や、一致区間に接する出現の扱い。設計は、置き換えられると見込む
    コピーを控えめに数える（設計本文の「すべての秘密を隠せるか確認する」）。

## 旧方式の実験

以下は旧方式の観測記録であり、新しい scan の受け入れ条件ではない。

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
