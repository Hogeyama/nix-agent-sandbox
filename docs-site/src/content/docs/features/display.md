---
title: X11 / xpra
description: agent 用の隔離 X server で GUI と browser automation を実行する
---

## どんな機能？

`display.sandbox = "xpra"` は host 上で xpra の detached X server（Xvfb backing）を session ごとに起動します。agent コンテナには、その X server の socket と session 専用の Xauthority cookie だけを渡すため、Playwright / Chromium などの GUI を使えます。

## いつ使う？

画面を必要とする browser automation や X11 application を sandbox 内で実行するときに使います。GUI が不要なら既定の `"none"` のままにしてください。host には `xpra`、xpra が起動する `Xvfb`、xpra が生成する cookie を読むための `xauth` が必要です。`xpra` を検出できても `Xvfb` を起動できない環境では display を開始できません。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `display.sandbox` | `"none"` | `"xpra"` で隔離 X server を有効にする。 |
| `display.size` | `"1920x1080"` | Xvfb の初期画面サイズ。`WIDTHxHEIGHT`、各値は 1〜16384。 |

## 最小の設定例

```pkl
display = new DisplayConfig {
  sandbox = "xpra"
  size = "1440x900"
}
```

nas は利用可能な `:100` 以上の display number を選び、コンテナへ `DISPLAY=:<number>` と `XAUTHORITY=~/.Xauthority` を設定します。Chromium 系の shared memory 使用量に備え、container の `/dev/shm` も 2 GiB に拡張します。

## 注意点・セキュリティへの影響

コンテナに mount するのは Xvfb socket 一つと、mode `0600` の per-session cookie だけです。host の `/tmp/.X11-unix` 全体、host desktop の `DISPLAY`、host desktop の Xauthority は agent に公開しません。xpra は host 側 viewer を auto-attach しようとしますが、これは host desktop を agent に渡すものではありません。

ただし auto-attach した viewer は、focus された agent 側 window へ host の keyboard input を送り、貼り付けた clipboard 内容も渡します。これは GUI を有効にした session への意図的な input trust boundary です。信頼できない agent に host 側の入力や clipboard を渡せない場合は、xpra を有効にしないでください。

session の scope が閉じると xpra process は停止します。異常終了で残った registry、session directory、socket は次回の runtime GC が掃除します。WSL などで `/tmp/.X11-unix` が read-only の場合は、private mount namespace で writable な per-session directory をそこへ bind して起動し、container にはその実体 socket だけを同じ `/tmp/.X11-unix/X<number>` として mount します。

viewer の input boundary は、[display forwarding のリスク](/nix-agent-sandbox/security/risks/#display-forwarding)も参照してください。

## 関連ページ

- [Docker in Docker](/nix-agent-sandbox/features/docker/) — GUI を含む container workflow に Docker が必要な場合
- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) — host path を渡す際の境界
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `DisplayConfig` の全定義
