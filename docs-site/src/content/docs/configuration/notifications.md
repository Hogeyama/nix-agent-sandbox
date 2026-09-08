---
title: 入力待ちの通知
description: エージェントの入力待ちを UI の状態とデスクトップ通知で確認するための設定
---

別の作業をしている間にエージェントが入力待ちになったことを知るには、使用するエージェントの hook に `nas hook` を登録します。これにより作業状態を記録し、入力待ちを通知できます。通信・ホスト実行の承認は別の要求として [Pending](/nix-agent-sandbox/work/approvals/) に届きます。

## 通知方法

[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)に設定します。

```pkl
hook = new HookConfig {
  notify = "auto"
}
```

`auto` は既定の通知方法、`desktop` はデスクトップ通知、`off` は通知なしです。`off` でも hook の作業状態は記録します。通知本文には入力データの `message` または既定文を使うため、秘密値を `message` に含めないでください。

## エージェントごとの登録

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

## Hook の実行環境

エージェント hook は `NAS_SESSION_ID` があるコンテナ内から実行されます。通知本文には hook 入力データの `message`、または既定文が表示されるため、秘密を `message` に含めないでください。`hook.notify = "off"` なら attention を記録してもデスクトップ通知は送りません。
