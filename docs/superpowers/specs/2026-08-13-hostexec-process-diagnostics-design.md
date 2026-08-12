# Hostexec process diagnostics design

## Goal

`forgejow` 実行後に Ctrl-C またはコンテナ停止で Hyprland が終了する問題について、次回の再現だけで signal の発生源と対象プロセスを特定できる証拠を残す。

## Design

Hostexec broker はセッションごとに `<hostexec runtime>/diagnostics/<session-id>.jsonl` を作り、broker 自身、spawn したコマンド、接続切断、SIGTERM/SIGKILL、子プロセス終了を JSON Lines で記録する。各イベントには timestamp、request ID、PID、PPID、process group、session、TTY foreground process group を含める。診断の書き込み失敗は hostexec 本来の実行を妨げない。

`forgejow` は Forgejo を起動・停止するとき、永続 state directory の `diagnostics/<repository-hash>.jsonl` に同じプロセス識別情報を記録し、`request-review` の出力にファイルパスを表示する。runtime directory は `down` で削除されるため、Forgejo 側の診断だけは再現後も残る state directory を使う。

## Events

- `broker_started`, `broker_closing`, `broker_closed`
- `command_spawned`, `client_disconnected`
- `signal_sent`, `command_exited`
- `forgejo_spawned`, `forgejo_signal_sent`

## Failure handling

Linux `/proc/<pid>/stat` が読めない場合もイベント自体は残し、プロセス情報を `null` にする。ログの open/append に失敗した場合は既存 logger へ warning を一度出すが、コマンドを失敗させない。

## Testing

`/proc` の stat parser と JSONL writer は unit test で確認する。Hostexec broker は実コマンドを起動する既存 integration test で spawn/exit イベントを確認する。`forgejow` は既存の実 Forgejo 統合テストで spawn イベントと表示された診断パスを確認する。

## Why — なぜこのアプローチを選んだか

通常の stdout は Ctrl-C やコンテナ停止で失われやすい。ホスト側 JSONL なら境界をまたいだ時系列と PID 関係が残り、signal の誤配送、PID 再利用、プロセスグループ共有を一度の再現で照合できる。

## Why Not — なぜ他の案を選ばなかったか

- **既存 audit DB に格納する** — policy decision 用 schema であり、process lifecycle を混在させると責務と保持期間が曖昧になる。
- **標準出力だけに debug log を出す** — 問題発生時に端末とコンテナが終了するため、最も必要な末尾が失われる可能性が高い。
- **`strace` を常時使う** — 侵襲性とログ量が大きく、まず必要な signal/PID 関係より範囲が広すぎる。
