---
title: 機能別リスク
description: 機能ごとの既定値、ホストへのアクセス権限、リスク
---

機能を追加すると、エージェントが利用できるホストのファイル、サービス、実行権限も変わります。各行のリンク先に設定方法があります。

## 機能ごとの権限とリスク

| 機能 | 既定・設定 | アクセス範囲と注意点 |
| --- | --- | --- |
| <span id="nix-socket">[Nix](/nix-agent-sandbox/features/nix/)</span> | `nix.enable = "auto"`、`mountSocket = true` | ホストに `/nix` があれば Nix store、Nix daemon、関連キャッシュを共有。ホストの状態も変更可能。不要なら `enable = false`。 |
| <span id="dind">[Docker in Docker](/nix-agent-sandbox/features/docker/)</span> | `docker.enable = false` | 有効時はセッション専用 daemon を利用。補助コンテナは `--privileged`。取得キャッシュは後のセッションでも再利用し、キャッシュ利用時は新たな通信承認なし。 |
| <span id="network-egress">[外部通信](/nix-agent-sandbox/features/network/)</span> | scope は空、fallback と WebSocket は `"deny"` | 許可した HTTP(S) 通信先へ接続。ヘッダー注入は秘密値の送信も許可。`host.docker.internal:<port>` の許可はホストの TCP サービスにも到達。WebSocket の認可は接続開始時のみ。 |
| <span id="port-forwarding">[localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/)</span> | `forwardPorts` は空 | 指定したホストのポートへ接続。転送先の DB や API の認証・権限で操作可能。 |
| <span id="port-bind">[コンテナポート公開](/nix-agent-sandbox/features/port-bind/)</span> | 未公開。`nas network bind` で追加 | エージェントが制御するサービスをホストの localhost に公開。ブラウザで開いたページから、他のローカルサービスへ要求を送信可能。 |
| <span id="hostexec">[HostExec](/nix-agent-sandbox/features/hostexec/)</span> | `hostexec = null` | ルールで許可したコマンドをホストの権限で実行。実行ファイルや入力をエージェントが変更できると、別の処理にも拡大。 |
| <span id="dbus">[DBus](/nix-agent-sandbox/recipes/codex-keyring/)</span> | `dbus.session.enable = false` | 許可したホストサービスのメソッドを利用。メソッドの制限だけでは、取得可能なキーリング項目などは限定されない。 |
| <span id="gpg-agent">GPG</span> | `gpg.forwardAgent = false` | gpg-agent ソケットと関連設定を共有。ロック解除中は署名・復号が可能。 |
| <span id="cloud-config-mounts">[クラウド認証設定](/nix-agent-sandbox/features/secrets/#クラウド設定と-gpg-エージェント)</span> | `gcloud.mountConfig` / `aws.mountConfig` は `false` | `~/.config/gcloud` / `~/.aws` を読み書き可能で共有。認証情報の利用だけでなく変更・削除も可能。 |
| <span id="extra-mounts">[追加マウント](/nix-agent-sandbox/features/filesystem/)</span> | `extraMounts` は空、`mode = "ro"` | 指定したファイルを共有。`ro` でも秘密は読める。`rw` ではホストのファイルを変更可能。 |
| <span id="ui-daemon">[ブラウザ UI](/nix-agent-sandbox/features/ui/)</span> | `ui.enable = true`、ポート `3939` | ターミナル、承認、履歴を操作。同じホストの別ユーザーからのアクセスは防がない。 |
| <span id="request-body-audit">[リクエスト本文の保存](/nix-agent-sandbox/operations/audit/#リクエスト本文の保存)</span> | `requestBodyAudit.enable = false` | マスク前の本文をホストの監査 DB に保存。秘密や個人情報を含み得る。本文の期限切れ削除では監査ログ全体は消えない。 |
| <span id="display-forwarding">[X11 / xpra](/nix-agent-sandbox/features/display/)</span> | `display.sandbox = "none"` | 専用画面のソケットと Cookie を共有。ビューアーへのキー入力と貼り付けはエージェント側に渡る。 |
| <span id="observability-retention">[実行履歴・利用量](/nix-agent-sandbox/features/observability/)</span> | `observability.enable = false`、保持期間 31 日 | 無効でも実行履歴は記録。有効時はプロンプトやツール入出力も保存され得る。`retention = null` は無期限。 |

## 設定変更時の確認事項

Unix ソケットで共有する場合も、接続先サービスの権限は利用できます。接続方法だけでなく、そのサービスで可能な操作を確認してください。[推奨設定](../recommendations/)と[隔離の範囲](../model/)に確認項目をまとめています。
