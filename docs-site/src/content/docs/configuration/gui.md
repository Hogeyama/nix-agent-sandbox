---
title: GUI アプリの表示
description: エージェント側のブラウザや X11 アプリを xpra の画面で確認する設定
---

コンテナ内の GUI アプリを見たり操作したりする場合は、セッション専用の画面を xpra ビューアーに表示します。開発サーバーをホストのブラウザで開くだけなら、[ポート公開](/nix-agent-sandbox/work/preview/)を使います。

## 必要な環境

ホストにデスクトップ環境があり、PATH 上の xpra、xauth と、xpra から起動できる Xvfb が必要です。使用する GUI アプリはコンテナのイメージに導入しておきます。

## 画面の設定

[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)に追加します。

```pkl
display = new DisplayConfig {
  sandbox = "xpra"
  size = "1440x900"
}
```

display.sandbox の既定は none で、xpra を指定すると専用画面を有効にします。size の既定は 1920x1080、WIDTHxHEIGHT の各値は1〜16384です。

設定を確認して再信頼し、そのプロファイルで起動します。エージェントに GUI アプリを起動させると、ホストでビューアーが自動接続します。Playwright CLI を導入済みなら、コンテナ内の `playwright-cli open --headed` でブラウザを開けます。

## 表示と入力の範囲

nas は空いている :100 以上のディスプレイ番号を選び、コンテナへ DISPLAY と XAUTHORITY を設定します。Chromium 系の共有メモリ使用量に備え、コンテナの /dev/shm も2 GiBになります。

共有するのは専用 Xvfb のソケットと権限0600の認証 Cookie です。ホストの既存デスクトップの DISPLAY、Xauthority、/tmp/.X11-unix 全体は共有しません。

**ビューアーへのキー入力と貼り付けは、エージェント側のアプリに届きます。** 秘密情報を入力する場合は、そのアプリへ渡してよい情報か確認してください。

## 表示の問題

| 状態 | 確認事項 |
| --- | --- |
| xpra not found on PATH | ホストの xpra と PATH |
| xauth not found on PATH | ホストの xauth と PATH |
| Xvfb の起動失敗 | Xvfb の導入状況と、セッションログが示す xpra ログ |
| ビューアーの接続失敗 | ホストの DISPLAY と、セッションディレクトリの xpra-attach.log |

ビューアーの接続に失敗しても、コンテナと X server は動作を続けます。WSL などで /tmp/.X11-unix が読み取り専用の場合は、ホストの unshare と mount、非特権ユーザー名前空間とマウント名前空間も必要です。

## 作業の終了

セッションの通常終了時には xpra も停止します。異常終了で残った登録情報、ディレクトリ、ソケットは次の起動時に回収します。
