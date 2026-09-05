---
title: 機能別リスク
description: host resource を追加する設定の既定値、到達先、実務上のリスク
---

ここでは capability を追加する機能を一行ずつ示します。`既定` は schema の値であり、host の存在を検出して有効になる `nix.enable = "auto"` のような条件付き既定も含みます。設定の具体例は各機能ページ、全体の境界は[設計思想と信頼境界](../model/)を参照してください。

## リスクマトリクス

| 機能 | 既定 | 有効にする設定 | 到達する resource | 実務上のリスク |
| --- | --- | --- | --- | --- |
| <span id="nix-socket">Nix socket</span> | `enable = "auto"`、`mountSocket = true`。host に `/nix` があれば有効。 | `nix.enable = true`、または auto のまま host Nix を検出。`mountSocket = true`。 | `/nix`、Nix daemon socket、Nix / nas cache。 | daemon を通じる build と store/state への影響を許す高信頼経路。Nix が不要なら明示的に `enable = false`。 [Nix 統合](/nix-agent-sandbox/features/nix/) |
| <span id="dind">Docker in Docker</span> | `docker.enable = false` | `docker.enable = true` | rootless DinD sidecar とその Docker daemon。 | agent container は host Docker socket を得ないが、sidecar は `--privileged` で起動する。`shared = true` は daemon とデータを session 間で共有する。 [Docker in Docker](/nix-agent-sandbox/features/docker/) |
| <span id="network-egress">network egress</span> | `network.scopes` は空、network / scope fallback と WebSocket は `"deny"`。 | scope の `targets` / `rules`、`onMatch = "allow"` / `"review"`、fallback、`webSocket = "allow"`、許可 rule の `inject` header。 | shared mitmproxy を通る upstream HTTP(S) と、inject した header。 | destination・request・WebSocket handshake を外部へ開け、review の再利用範囲も設定する。header injection は許可した upstream に secret を送る capability。`host.docker.internal:<port>` を明示した scope は、sidecar の host-gateway TCP 経由で host service へも到達できる。 [ネットワーク制御](/nix-agent-sandbox/features/network/) |
| <span id="port-forwarding">localhost ポート転送</span> | 空 | `network.proxy.forwardPorts` | 指定した host `127.0.0.1:<port>`。 | per-session relay でも、その service の認証・権限で操作できる。DB や管理 UI を無認証のまま渡さない。 [localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/) |
| <span id="port-bind">コンテナポート公開</span> | 未公開 | `nas network bind` または UI の `Bind` | container `127.0.0.1:<container-port>` を host `127.0.0.1:<host-port>` に公開。 | agent が制御する service を host から利用可能にする。ブラウザで開いた content は、ほかの host loopback service へ request を送れる。loopback だけを認可境界にしない。 [コンテナポート公開](/nix-agent-sandbox/features/port-bind/) |
| <span id="hostexec">HostExec</span> | `hostexec = null` | `hostexec.rules` | rule が許す host command、cwd、env。 | rule、実行ファイル、PATH、設定・入力ファイルのどれかを agent が変えられると host 任意実行へ広がり得る。 [HostExec](/nix-agent-sandbox/features/hostexec/) |
| <span id="dbus">DBus</span> | `dbus.session.enable = false` | `dbus.session.enable = true` と `talk` / `see` / `calls` 等。 | filtered host session bus と許可した service。 | filter は service の authority を弱めない。広い name / rule は keyring などの host asset を渡す。 [Codex の keyring](/nix-agent-sandbox/recipes/codex-keyring/) |
| <span id="gpg-agent">GPG agent</span> | `gpg.forwardAgent = false` | `gpg.forwardAgent = true` | gpg-agent socket、公開鍵 ring、trust DB、設定。 | unlock 中なら署名・復号を使える。必要な profile 以外では無効にする。 [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) |
| <span id="cloud-config-mounts">cloud config mounts</span> | 両方 `false` | `gcloud.mountConfig = true` / `aws.mountConfig = true` | `~/.config/gcloud` / `~/.aws` の認証設定。 | read/write mount なので agent は credential を読むだけでなく、host の認証・設定を永続的に変更・削除できる。短命・専用 credential を選ぶ。 [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) |
| <span id="extra-mounts">追加マウント</span> | 空、`mode = "ro"` | `extraMounts`、特に `mode = "rw"` | 指定した host file / directory。 | `rw` は host 実体を変更でき、後続の HostExec や login state に影響し得る。`ro` でも secret は読める。 [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) |
| <span id="ui-daemon">UI daemon</span> | `ui.enable = true`、loopback port `3939` | `ui.enable`、`nas ui`、`ui.port`。 | session terminal、approval、audit/history を扱う host-local daemon。 | Host/Origin/token は remote web origin を防ぐが、同一 host の別 user / process は信頼境界内。 [UI daemon](/nix-agent-sandbox/features/ui/) |
| <span id="request-body-audit">request-body audit</span> | `requestBodyAudit.enable = false` | `requestBodyAudit.enable = true` | host audit DB の mask 前 raw request body。 | 認証 header 以外の secret や個人情報を保存し得る。body retention と capacity は audit metadata を消さない。 [ネットワーク制御](/nix-agent-sandbox/features/network/) |
| <span id="display-forwarding">display forwarding</span> | `display.sandbox = "none"` | `display.sandbox = "xpra"` | per-session Xvfb socket と cookie、auto-attached viewer。 | host desktop X server は渡さないが、focused viewer の keyboard と clipboard は agent application に届く。 [X11 / xpra](/nix-agent-sandbox/features/display/) |
| <span id="observability-retention">observability retention</span> | `observability.enable = false`、retention は 31 日 | `observability.enable = true`、`observability.retention`。 | host history DB の invocation、trace/span/log。 | lifecycle history は enable にかかわらず記録され、telemetry では prompt/tool content を保存し得る。`null` は無期限。 [Observability](/nix-agent-sandbox/features/observability/) |

## 読み方

この表の Unix socket は「安全な resource」と同義ではありません。socket は container から host TCP 全体を見せないための transport boundary であり、resource の permission は行先の daemon / service が決めます。設定を追加するたび、その行の resource を agent に使わせてよいか確認してください。

## 関連ページ

- [推奨設定](../recommendations/) — capability を小さく保つ手順
- [制約・注意事項](../limitations/) — runtime と cleanup の限界
