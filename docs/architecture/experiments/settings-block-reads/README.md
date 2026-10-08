# settings.json 構成（系統1）の読取り・書込み制限の確認

**[系統1の設定例](../../threat-model-configurations.md#系統1)を user settings として与えた Claude Code で、Bash の読取り・書込み・通信の制限、本体の Read の拒否、書込みツールの除去、`GH_TOKEN` の代理注入が期待どおりに働いた。** 一方、設定の重ね方と `socat` の置き場所によっては、制限が丸ごと外れたり、Bash の通信がすべて失敗したりした。

## 環境

- Claude Code 2.1.291、NixOS ホスト上で直接実行（container の外）
- `claude --settings ./claude-settings-type1.json` で起動。設定は系統1の例を user settings 向けに直したもの（repo 名を実在のものに、作業領域の `.claude` を絶対パスに置き換え、managed settings でしか効かないキーを除いた）
- 2026-10-08 に実施

## 結果

| 確認項目 | 方法 | 結果 |
| --- | --- | --- |
| Bash からホームの読取り | `~/.zshrc`・`~/.claude/settings.json`・statusLine のスクリプトを 0 バイト読む、`~/.ssh` を一覧 | 拒否。ホームは中身のない領域に見えた |
| Bash から作業領域内 `.env` の読取り | 同上 | 拒否 |
| Bash から `/etc` の読取り | 同上 | 可（`blockReadsOutsideWorkingDirectories` の対象外。仕様どおり） |
| Bash から作業領域の `.claude` への書込み | 空ファイルを作成 | 拒否 |
| Bash から `~/.claude`・`~/`・`/tmp` への書込み | 空ファイルを作成し、ホストで有無を確認 | sandbox 内では成功したが、次のコマンドでは消えており、ホストにも存在しなかった |
| 本体の Read で作業領域外を読む | `/etc/hostname` を Read | `blockReadsOutsideWorkingDirectories` を理由に拒否 |
| 本体の Edit・Write・NotebookEdit | ツール一覧 | 除去されていた |
| Bash の通信先 | `curl` で各 hostname に接続 | `github.com`・`api.github.com` は 200。`example.com` は allowlist 外、`api.anthropic.com` は denylist で拒否 |
| `GH_TOKEN` の代理注入 | sandbox 内とホストの値の SHA-256 を比較し、`GET /user` を送る | 値は異なり（sandbox 内はダミー）、要求は 200 |
| 持込み token | 偽の token を付けて `GET /user` | 上書きされずに GitHub へ届き、401 |

最後の行は、A1b を ○ とする[評価](../../threat-model.md#系統1-settingsjson)と一致する。proxy は登録した token のダミー値を本物へ置き換えるが、他の token を付けた要求はそのまま通す。

## 途中で見つかった成立条件

### `--settings` は既存の設定を置き換えない

最初は既存の `~/.claude/settings.json`（`sandbox.filesystem.disabled: true`、`network.allowedDomains: ["*"]` 等を含む）を残したまま、`--settings` で系統1の設定を重ねた。この状態では、ホームの読取り、`~/.claude` への書込み、`example.com` への通信がすべて成功した。

`--settings` の値は他の設定と合算される。真偽値は明示しなければ下位の値が残り、配列は結合されるので `*` を消せない。系統1の設定は、managed settings に置くか、既存の設定ファイルそのものを置き換えて使う。

### Linux では `socat` をホームの外に置く

既存の設定を置き換えた後、Bash の通信が宛先にかかわらず `Could not connect to server` で失敗した。sandbox 内では proxy の待受け（`localhost:3128`）が存在せず、`socat` が PATH 上に見つからなかった。ホストの `socat` は `~/.nix-profile/bin` にあり、`blockReadsOutsideWorkingDirectories` がホームごと隠していた。`socat` をホーム外の PATH から見えるようにすると、上表の通信結果になった。

この失敗は拒否ではなく接続不能として現れ、違反の通知も出ない。通信先の制限が効いているように見えるため、許可先へ実際に接続できることを確かめてから、拒否の結果を評価する。`credentials` を外しても、`/tmp` の `denyRead` を外しても症状は変わらなかった。

### `CLAUDE_CODE_TMPDIR` の相対パス

`CLAUDE_CODE_TMPDIR` を `.local/tmp` と相対パスで与えると、sandbox 内の `TMPDIR` も相対パスになった。Bash で `cd` した後はヒアドキュメント用の一時ファイルを作れず、コマンドが失敗した。制限には影響しないが、絶対パスで与える。

## 2.1.294 での追加確認

2026-10-08 に、Claude Code 2.1.294 をホストで直接実行した別の作業で確かめた。設定は系統1の例そのものではなく、`blockReadsOutsideWorkingDirectories` を有効にし、`denyRead` に `/tmp`・`~/.ssh`・`~/.aws`・`~/.config/gh`、`allowRead` に `/tmp/claude-http-*.sock`、`denyWrite` に `~/.claude`・`~/.claude.json` を置いたもの。

| 確認項目 | 方法 | 結果 |
| --- | --- | --- |
| `/tmp` を拒否した状態の通信 | 上の設定で `curl` | `github.com` は 200。`example.com` は allowlist 外として拒否 |
| 起動時に存在しない `denyWrite` の対象 | sandbox 内で作業領域の `.claude/hooks`・`.claude/loop.md` 等を `stat` し、ホストで `git status` | sandbox 内では `/dev/null`（キャラクタデバイス 1,3、所有者 `nobody`）に見えた。ホストには作られていなかった |
| `denyRead` の対象 | 作業領域の `.env` を `stat` | 同じく `/dev/null` に見えた |
| global の Git 設定 | `git config user.name` | `~/.config/git/config` と `ignore` は `/nix/store` へのシンボリックリンクで、自動で読めるように戻されるパスに含まれていたが、sandbox 内に現れなかった。作者情報が空になり、global の ignore も効かなかった。普通のファイルの `config.local` は見えた |
| 同上（ディレクトリで許可） | `allowRead` に `~/.config/git` を追加 | リンクが現れ、作者情報と global の ignore が読めた |
| 作業領域外を指す Bash のコマンド | `ls /tmp/` | sandbox で実行する前に、`blockReadsOutsideWorkingDirectories` を理由に実行の確認を求められた |

`/dev/null` に置き換えられたパスは、sandbox 内の `git status` に未追跡や変更ありとして出る。ホストで見るとこれらは出ない。

`socat` は、作業領域の flake の devShell に入れると `/nix/store` 上の PATH から見えるので、「ホームの外に置く」条件を満たす。

## 確認していないこと

- `allowRead` の例外を置かずに `/tmp` を拒否した場合の通信。srt では `/tmp` の拒否が proxy 用 socket を隠した（[系統2](../../threat-model-configurations.md#系統2)）
- 起動時に存在しない `denyWrite` の対象への書込みが拒否されること（`/dev/null` に置き換えられることまでは確認した）
- hook・statusLine の参照先を書き換えられないこと（`~/.claude` と作業領域の `.claude` への書込み拒否までは確認した）
- managed settings に置いた場合の挙動
