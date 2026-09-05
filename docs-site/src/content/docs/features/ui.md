---
title: ブラウザ UI
description: ブラウザでのセッション管理、ターミナル、承認操作
---

セッション一覧、ターミナル、通信・HostExec の承認をブラウザで操作できます。UI は既定でセッション起動時に自動起動し、`127.0.0.1:3939` で待ち受けます。

## 起動・停止

ブラウザで開くには、ホストで次を実行します。

```sh
nas ui
```

起動オプションと停止コマンドは次のとおりです。

```sh
nas ui --no-open --port 4040 --idle-timeout 0
nas ui stop
nas ui stop --port 4040
```

`--no-open` はブラウザを開かずに起動します。`--port` と `--idle-timeout` はその起動だけに適用されます。

## 画面の操作

| 画面 | 操作 |
| --- | --- |
| Sessions | セッションの選択・名前変更・ターミナル表示。エージェントの停止はターミナルのツールバー。 |
| Pending | 通信と HostExec の承認・拒否。選択中または全セッションの要求を表示。 |
| Ports · in | コンテナのポート公開、URL の確認、公開解除。 |
| Settings → Sidecars | `dind`、`proxy`、`registry-mirror` の状態確認と停止。 |
| Settings → Audit | 許可・拒否の記録と検索。 |
| Settings → Preferences | 文字サイズとペイン幅の変更。 |
| History | 会話、処理記録、トークン使用量の確認。 |

<img src="/nix-agent-sandbox/images/ui-sessions.png" width="900" alt="セッション一覧と、選択したセッションのターミナル" />

## 設定項目

`.nas/config.pkl` のトップレベルに指定します。`profiles` の外側です。

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `ui.enable` | `true` | `nas` のセッション起動時に UI を自動起動する。`false` では自動起動しない。 |
| `ui.port` | `3939` | UI の待ち受けポート。 |
| `ui.idleTimeout` | `300` | セッションと承認待ちの要求がすべてなくなってから自動停止するまでの秒数。`0` は自動停止しない。 |

## 注意点

UI は同じホストの利用者を信頼する前提です。`127.0.0.1` での待ち受け、Host / Origin の検査、ターミナル用トークンは、同じホストの別ユーザーからのアクセスを防ぎません。そのユーザーも画面とトークンを取得できます。

共有ホストでは、ターミナル、承認操作、履歴を他の利用者に扱わせてよいか確認してください。詳細は[ブラウザ UI のリスク](/nix-agent-sandbox/security/risks/#ui-daemon)を参照してください。

## 関連ページ

- [セッション・通知](/nix-agent-sandbox/features/sessions/) — 再接続と通知の設定
- [ネットワーク制御](/nix-agent-sandbox/features/network/) — ネットワーク承認の意味
- [コンテナポート公開](/nix-agent-sandbox/features/port-bind/) — CLI からのポート公開
- [HostExec](/nix-agent-sandbox/features/hostexec/) — ホストコマンド承認の意味
- [実行履歴・利用量](/nix-agent-sandbox/features/observability/) — History が読む処理・利用量データと保持期間
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `UiConfig` の全定義
