---
title: X11 / xpra
description: コンテナ内の GUI アプリ用の画面設定
---

GUI 付きブラウザや X11 アプリをコンテナで使うには、`display.sandbox = "xpra"` を設定します。nas はセッション専用の X server を起動し、ホストの xpra ビューアーに表示します。

ホストには `xpra`、`Xvfb`、`xauth`、コンテナには使用する GUI アプリが必要です。手順と起動時のエラーは [X11 アプリの表示](/nix-agent-sandbox/recipes/x11-apps/)を参照してください。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

```pkl
display = new DisplayConfig {
  sandbox = "xpra"
  size = "1440x900"
}
```

nas は利用可能な `:100` 以上のディスプレイ番号を選び、コンテナへ `DISPLAY=:<number>` と `XAUTHORITY=~/.Xauthority` を設定します。Chromium 系の共有メモリ使用量に備え、コンテナの `/dev/shm` も 2 GiB に拡張します。

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `display.sandbox` | `"none"` | `"xpra"` で専用の X server を有効にする。 |
| `display.size` | `"1920x1080"` | Xvfb の初期画面サイズ。`WIDTHxHEIGHT`、各値は 1〜16384。 |

## 注意点

コンテナに渡すのは、セッション専用の Xvfb ソケットと、権限 `0600` の認証 Cookie です。ホストの既存デスクトップの `DISPLAY` や Xauthority、`/tmp/.X11-unix` 全体は共有しません。

xpra ビューアーへのキー入力と貼り付けは、エージェント側のアプリに届きます。扱う内容をそのエージェントに渡してよいか確認してください。

通常の終了時には xpra も停止します。異常終了で残った登録情報、ディレクトリ、ソケットは次回の起動時に回収します。環境ごとの前提やエラーは [X11 アプリの表示](/nix-agent-sandbox/recipes/x11-apps/)を参照してください。

## 関連ページ

- [Docker in Docker](/nix-agent-sandbox/features/docker/) — GUI を含むコンテナ操作に Docker が必要な場合
- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) — ホストパスを渡す際の境界
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `DisplayConfig` の全定義
