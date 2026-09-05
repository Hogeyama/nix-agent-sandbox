---
title: セッション・通知
description: ターミナルの切り離し・再接続と入力待ち通知
---

ターミナルを切り離した後もエージェントを動かし続け、後から再接続できます。`session.multiplex = true` と、ホストの `dtach` が必要です。

入力待ちの通知は、エージェントの hook に `nas hook` を設定します。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

```pkl
session = new SessionConfig {
  multiplex = true
  detachKey = "^\\"
}

hook = new HookConfig {
  notify = "auto"
}
```

起動後は設定したキーでターミナルを切り離せます。既定の `^\` は Ctrl+\ です。再接続には一覧のセッション ID を指定します。

```sh
nas session list
nas session attach sess_abc123
```

複数のターミナルから同じセッションに接続できます。入力も共有されるため、同時操作に注意してください。`nas session attach` で再接続した場合の切り離しキーは、プロファイルの指定にかかわらず dtach の既定値です。

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `session.multiplex` | `false` | dtach でセッションを起動し、切り離しと再接続を可能にする。 |
| `session.detachKey` | `"^\\"` | 初回接続時の切り離しキー。 |
| `hook.notify` | `"auto"` | 入力待ち時の通知を `"auto"`、`"desktop"`、`"off"` から選ぶ。 |

## 通知の設定

使用するエージェントの例を選んで設定します。`nas hook` は作業開始・入力待ち・終了を記録し、入力待ちの `attention` だけを通知します。既存の hook がある場合は、その設定を残して追加してください。

### Claude Code

`~/.claude/settings.json` または `.claude/settings.json` に設定します。

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "nas hook --kind start" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "nas hook --kind start" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "nas hook --kind attention" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "nas hook --kind attention" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "nas hook --kind stop" }] }]
  }
}
```

### GitHub Copilot CLI

リポジトリの `.github/hooks/*.json` に設定します。この例では、`ask_user` の前後だけを `--when toolName=ask_user` で選びます。`notification` を無条件に attention にすると `permission_prompt` も拾うため設定しません。`--when path=value` は入力 JSON の値が完全一致した場合だけ記録します。複数指定時はすべての一致が必要です。条件の不一致や入力・保存の失敗は hook を失敗させません。

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "type": "command", "bash": "nas hook --kind start", "timeoutSec": 10 }],
    "userPromptSubmitted": [{ "type": "command", "bash": "nas hook --kind start", "timeoutSec": 10 }],
    "preToolUse": [{ "type": "command", "bash": "nas hook --kind attention --when toolName=ask_user", "timeoutSec": 10 }],
    "postToolUse": [{ "type": "command", "bash": "nas hook --kind start --when toolName=ask_user", "timeoutSec": 10 }],
    "sessionEnd": [{ "type": "command", "bash": "nas hook --kind stop", "timeoutSec": 10 }]
  }
}
```

### OpenAI Codex CLI

`~/.codex/config.toml` または `.codex/config.toml` に設定します。

```toml
[[hooks.SessionStart]]
matcher = "startup|resume"
[[hooks.SessionStart.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind start || true'"

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind start || true'"

[[hooks.PreToolUse]]
matcher = "*"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind start || true'"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind attention || true'"

[[hooks.SessionEnd]]
[[hooks.SessionEnd.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind stop || true'"
```

## 注意点

エージェント hook は `NAS_SESSION_ID` があるコンテナ内から実行されます。通知本文には hook 入力データの `message`、または既定文が表示されるため、秘密を `message` に含めないでください。`hook.notify = "off"` なら attention を記録してもデスクトップ通知は送りません。

## 関連ページ

- [Worktree](/nix-agent-sandbox/features/worktree/) — セッションごとの作業フォルダーの分離
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `SessionConfig` と `HookConfig` の全定義
