---
title: セッション・通知
description: dtach の再接続と agent hook による状態通知
---

## どんな機能？

`session.multiplex` は nas を dtach session として起動します。terminal を detach しても agent は動き続け、後から再接続できます。agent hook の `nas hook` は session を「作業中」「入力待ち」「終了」として記録し、入力待ちでは desktop notification を送れます。

## いつ使う？

長い agent run を terminal 切断から守る、または複数の run のうち入力待ちのものを見つけたいときに使います。dtach が host にない環境では multiplex を有効にできません。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `session.multiplex` | `false` | dtach で session を起動し、detach / attach を可能にする。 |
| `session.detachKey` | `"^\\"` | 最初の attach で使う dtach の detach key。 |
| `hook.notify` | `"auto"` | attention 時の通知を `"auto"`、`"desktop"`、`"off"` から選ぶ。 |

## 最小の設定例

```pkl
session = new SessionConfig {
  multiplex = true
  detachKey = "^\\"
}

hook = new HookConfig {
  notify = "auto"
}
```

起動後は active session を確認して再接続できます。

```sh
nas session list
nas session attach sess_abc123
```

同じ dtach socket には複数 terminal から attach できます。すべて同じ agent process を表示・操作するため、入力を同時に送らないよう運用してください。`detachKey` は最初の attach に渡されますが、現在の `nas session attach` は profile を読み直さず dtach の既定 key で attach します。

## agent hook の例

hook は stdin の JSON payload を読み、`start`、`attention`、`stop` のいずれかを記録します。`attention` だけが通知対象です。`--when path=value` は JSON のドット区切り path に対する文字列の完全一致で、複数あればすべて一致したときだけ記録します。不一致、壊れた payload、通知や保存の失敗は agent hook を失敗させません。

Claude Code（`~/.claude/settings.json` または `.claude/settings.json`）:

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

GitHub Copilot CLI（repository の `.github/hooks/*.json`）では、`ask_user` の前後だけを `--when toolName=ask_user` で選びます。`notification` を無条件に attention にすると `permission_prompt` も拾うため設定しません。

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

OpenAI Codex CLI（`~/.codex/config.toml` または `.codex/config.toml`）:

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

## 注意点・セキュリティへの影響

agent hook は `NAS_SESSION_ID` がある sandbox 内から実行されます。通知本文には hook payload の `message`、または既定文が表示されるため、秘密を message に含めないでください。`hook.notify = "off"` なら attention を記録しても desktop notification は送りません。

## 関連ページ

- [Worktree](/nix-agent-sandbox/features/worktree/) — session ごとの作業 tree を分ける
- [HostExec](/nix-agent-sandbox/features/hostexec/) — hook は host 側の session store へ状態を届ける
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `SessionConfig` と `HookConfig` の全定義
