---
title: X11 アプリの表示
description: xpra による GUI アプリの表示手順と起動時のエラー
---

コンテナで起動した GUI アプリを、ホストの xpra ビューアーに表示する手順です。

## 前提条件

- エージェントの API への通信許可を設定済み。Claude Code の例は[クイックスタート](/nix-agent-sandbox/getting-started/quick-start/)を参照。

- ホストの PATH に `xpra`、`xauth` があり、xpra が `Xvfb` を起動できる。
- ホストにデスクトップ環境がある。
- 使用する GUI アプリをコンテナのイメージに導入済み。

## 設定例

エージェントとの通信を設定済みの `claude` プロファイルに、以下の設定を追加します。編集先は[プロファイルの編集](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)を参照してください。既存の設定項目がある場合は、その中に要素を追加し、通信先やルールを残してください。

```pkl
display {
  sandbox = "xpra"
  size = "1920x1080"
}
```

## 起動

設定を確認して `nas config trust` を実行し、`nas claude` で起動します。その後、エージェントに GUI アプリを起動させます。Playwright CLI を導入済みなら `playwright-cli --headed` を使えます。

nas はホストで `xpra attach :<display-number>` を自動実行します。通常は手動接続は不要です。

## 起動時のエラー

| 状態 | 確認事項 |
| --- | --- |
| `xpra not found on PATH` | ホストへの xpra の導入と PATH。 |
| `xauth not found on PATH` | ホストへの xauth の導入と PATH。 |
| Xvfb の起動失敗 | Xvfb の導入状況と、セッションログに記載された xpra ログ。 |
| ビューアーの接続失敗 | ホストの `DISPLAY` と、セッションディレクトリの `xpra-attach.log`。コンテナと X server は動作を続行。 |

WSL などで `/tmp/.X11-unix` が読み取り専用の場合は、ホストの `unshare` と `mount`、非特権ユーザー名前空間とマウント名前空間が必要です。

## 入力の共有範囲

ホストの既存 X server や認証 Cookie は共有しません。ただし、xpra 画面へのキー入力と貼り付けは、エージェント側のアプリに渡ります。詳しくは [X11 / xpra](/nix-agent-sandbox/features/display/)を参照してください。
