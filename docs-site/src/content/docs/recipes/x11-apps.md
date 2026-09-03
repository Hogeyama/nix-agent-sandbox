---
title: X11 アプリを表示する
description: xpra の Xvfb-backed display で headed application を起動する
---

## 得られること

agent が起動する headed browser などを、ホストの通常の X display を渡さずに表示できます。
nas は xpra の detached X server を session ごとに起動し、Xvfb socket と per-session
cookie だけをコンテナへ渡します。

## 前提

- ホストの PATH に `xpra` と `xauth` がある。xpra が起動する Xvfb も必要である。
- headed application はコンテナ image 内にインストール済みである。
- viewer を表示する host desktop session がある。

```pkl
amends "Schema.pkl"

profiles {
  ["browser"] {
    agent = "claude"
    display {
      sandbox = "xpra"
      size = "1920x1080"
    }
  }
}
```

起動後、agent に headed application を起動させます。たとえば Playwright を既に image に
入れているなら、agent 内で `playwright-cli --headed` を使います。nas は host 側で
`xpra attach :<display-number>` も自動起動し、`[nas] xpra :<display-number> ready
(auto-attached).` と表示します。通常は手動で attach し直す必要はありません。

## 権限と注意点

`display.sandbox = "xpra"` は host の既存 X session やその cookie をコンテナへ
マウントしません。一方、xpra viewer の focused keyboard 入力と貼り付けた clipboard は
agent 側 application に渡ります。表示・入力する内容をその agent に任せてよい場合だけ
attach してください。

`[nas] xpra not found on PATH` は xpra を、`[nas] xauth not found on PATH` は xauth を
導入してから再試行します。Xvfb 起動で止まる場合は、xpra が利用できる Xvfb を host に
導入し、session log に出る xpra log path を確認します。host に `DISPLAY` がないなどで
auto-attach が失敗しても、agent container と X server は動作を続けます。session directory
の `xpra-attach.log` を確認して host display 側を直してください。WSL で `/tmp/.X11-unix`
が read-only の場合、nas は private mount namespace を使うため、unprivileged user namespace
と mount namespace が利用可能で、host の `unshare` と `mount` binary が必要です。nas は
private namespace 内で `mount --bind` を実行するため、どれかがない場合は display setup が失敗します。

viewer へ渡る keyboard / clipboard と session socket の範囲は、[display forwarding のリスク](/nix-agent-sandbox/security/risks/#display-forwarding)を確認してください。

## 関連ページ

- [X11 / xpra](/nix-agent-sandbox/features/display/)
- [セッション・通知](/nix-agent-sandbox/features/sessions/)
