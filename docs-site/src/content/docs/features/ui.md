---
title: UI daemon
description: session、承認、sidecar、履歴を localhost のブラウザ画面で操作する
---

## どんな機能？

UI daemon は host の `127.0.0.1` だけで待ち受ける `nas` の control room です。session の一覧と terminal、network / HostExec の pending approval、sidecar、監査ログ、履歴、表示設定を一つのブラウザ画面で扱えます。新しい session を作る画面もここから開けます。

## いつ使う？

複数 session の状態を見比べる、保留中の承認を確認する、または terminal をブラウザで使いたいときに有効です。単一の terminal だけで作業し、承認も desktop notification の action で処理するなら無効にできます。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `ui.enable` | `true` | `nas` の session 起動時に daemon を自動起動する。`false` では自動起動しない。 |
| `ui.port` | `3939` | loopback listener と `nas ui` の既定 port。 |
| `ui.idleTimeout` | `300` | session と pending approval がすべてなくなってから自動停止するまでの秒数。`0` は自動停止しない。 |

## 最小の設定例

```pkl
ui = new UiConfig {
  enable = true
  port = 3939
  idleTimeout = 300
}
```

`ui.enable = true` のとき、通常の `nas <profile>` は必要になった daemon をバックグラウンドで起動します。daemon が既に健全なら再利用します。idle 判定は running session と network / HostExec の pending request を確認し、どちらもない状態が timeout の間続いたときだけ停止します。

明示的に起動・停止するには次を使います。`nas ui` は既定では browser を開き、`--no-open` は起動だけを行います。`--port` と `--idle-timeout` は一度の起動に対する上書きです。

```sh
nas ui
nas ui --no-open --port 4040 --idle-timeout 0
nas ui stop
nas ui stop --port 4040
```

## 画面でできること

- 左の Sessions pane では session の名前、状態、profile、作業ディレクトリ、worktree、ID と pending 件数を見て、選択・名前変更・terminal 表示を切り替えます。
- 右の Pending pane では network と HostExec の request を、選択中の session または全 session で絞り込めます。カードの対象、rule、理由、承認範囲を確認して Allow / Deny を選びます。承認範囲はそのカードに表示された内容に従います。
- 選択した session の `Ports · in` panel では、コンテナ内で検出した待ち受け port の公開、port 番号の直接指定、公開 URL、既存 binding の解除を操作します。
- Settings の Sidecars では `dind` と `proxy` の sidecar の名前、種別、状態、uptime を確認し、それぞれを Stop できます。agent container はこの一覧には出ず、選択した session の terminal toolbar から Stop します。
- Settings の Audit は承認・拒否の永続 audit log を表示します。domain、session ID の部分一致、active session のみで絞り込み、古い行を追加で読み込みます。Preferences では画面の font size と pane 幅を変えられます。
- History は conversation を起点に、profile / agent / worktree、trace、span、token と cache token の集計、関連 invocation を表示します。データは UI を開いている間に更新されます。

<img src="/nix-agent-sandbox/images/ui-sessions.png" width="900" alt="Sessions pane に二つの Claude Code session と状態が並び、選択した session の terminal 履歴を表示する UI daemon 画面。" />

この画面は、複数 session の状態を左で比較し、選択した session の会話・terminal を中央で操作する状態を示します。

<img src="/nix-agent-sandbox/images/ui-containers.png" width="900" alt="以前の UI daemon の Containers 表で、agent、envoy、dind の三つの稼働 container と Stop 操作を表示する画面。" />

この画像は以前の Containers 画面の視覚的な参考です。agent、Envoy、DinD を一つの表に並べており、現在の control と一対一には対応しません。現在の Settings の Sidecars は `dind` / `proxy` だけを表示・停止し、agent container の停止は選択した session の terminal toolbar で行います。

## 注意点・セキュリティへの影響

UI は `127.0.0.1` に bind し、loopback の Host / Origin を検査して DNS rebinding、CSRF、cross-site WebSocket を防ぎます。terminal WebSocket には browser に渡された token も必要です。しかし、**同じ host の別ユーザーは信頼境界の内側です**。同居プロセスは loopback へ接続でき、HTML shell とその token を読めます。これは hostile local user からの隔離を提供する認証機構ではありません。

そのため、信頼できないユーザーと host を共有する場合は、そのユーザーに UI、browser profile、または承認を操作できる desktop notification の surface を渡さないでください。network / HostExec の approval は capability を広げる判断です。request の target、rule、command、scope を確認し、必要以上に広い承認を選ばないでください。

loopback listener の前提と扱える control surface は、[UI daemon のリスク](/nix-agent-sandbox/security/risks/#ui-daemon)を参照してください。

## 関連ページ

- [セッション・通知](/nix-agent-sandbox/features/sessions/) — dtach session と notification の設定
- [ネットワーク制御](/nix-agent-sandbox/features/network/) — network approval の意味
- [コンテナポート公開](/nix-agent-sandbox/features/port-bind/) — `Ports · in` panel と同じ binding を CLI から操作する
- [HostExec](/nix-agent-sandbox/features/hostexec/) — host command approval の意味
- [Observability](/nix-agent-sandbox/features/observability/) — History が読む telemetry と保持期間
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `UiConfig` の全定義
