---
title: 設計思想と信頼境界
description: nas が分離する経路と、設定で追加される host capability を確認する
---

nas の network schema は `network.fallback`、scope `fallback`、WebSocket を既定で deny にします。scope や rule がない request はその fallback に従いますが、設定では `allow` / `review` を選べ、Anthropic preset も fallback を `review` にします。したがって deny-by-default は変更不能な不変条件ではなく、安全側の既定値です。host service の明示的な経路には Unix socket を使いますが、それだけが host 到達経路ではありません。ただし Docker コンテナだけを敵対的な agent や repository に対する完全な境界とは見なしません。workspace、agent の既存設定・認証 directory、opt-in の mount、broker に委ねた capability は、その構成で信頼した範囲です。

## セッションの経路

```text
agent container
├─ workspace view (通常は rw。maskfs 時は FUSE の表示ビュー)
├─ per-session Unix sockets
│  ├─ HostExec exec socket ──> host HostExec broker ──> 許可した host command
│  ├─ forward-port relay ───> host 127.0.0.1:<明示した port>
│  ├─ DBus proxy socket ────> filtered host session bus
│  └─ X11 socket + cookie ──> per-session xpra/Xvfb
└─ HTTP(S) proxy ───────────> shared mitmproxy sidecar
                                   ├─ per-session Unix socket（認可制御・decision）
                                   │  └──────────────> host session broker / trust boundary
                                   └─ 許可された HTTP(S) data path ──> upstream network

host-only: HostExec control socket (approve / deny / pending)、HostExec control state、
secret frame、audit/history database

sidecar-visible: network runtime dir（session registry、resolved authz document、
per-session network broker socket。shared mitmproxy に read/write mount）

host browser / process
└─ 127.0.0.1:<host port> ──> host port-bind listener ──> per-session relay socket
                                                       └─> container 127.0.0.1:<container port>
```

shared proxy や shared DinD sidecar は複数 session に再利用され得ます。対して network broker、port relay、DBus proxy、HostExec gateway、xpra display は session ごとの runtime path を使います。共有 sidecar を別の信頼境界の session と混ぜないでください。

shared mitmproxy sidecar には `host.docker.internal:host-gateway` の host-gateway mapping もあります。scope が `host.docker.internal:<port>` を明示して許可すれば、sidecar はその TCP host service へ到達できます。この経路は per-session Unix socket relay ではないため、host service を socket だけで隔離できるとは考えず、host-gateway target は特に狭く設定します。

## 守る不変条件

- 名前付き secret の解決と secret frame の読取りは host 側だけで行います。生の secret をコンテナの file や通常の環境変数へ mount しません。HostExec rule の明示的な `env` 注入だけは、許可された host command に対する例外です。
- HostExec の stdout / stderr も、`mask.filter` と profile の `mask.apply` を正しく設定すれば host 側 filter で mask されます。注入 registry だけを設定しても mask 対象にはなりません。
- コンテナへ mount する HostExec **exec socket** は execute / fallback 専用です。approve、deny、pending 一覧を扱う **control socket** は host broker directory にだけ置かれ、コンテナへ公開しません。
- host service の socket を TCP で広く公開する代わりに、必要な session に必要な Unix socket を渡します。それでも、その socket の先にある service の権限は agent が使えます。

<span id="repository-trust"></span>

## repository を信頼する境界

`.nas/config.pkl` は HostExec、mount、network、`env` command、worktree `onCreate` を host 側へ影響させられます。nas は `.nas/` 直下のユーザー作成 `.pkl` の content hash を記録し、変更時は再信頼を求めます。確認後だけ `nas config trust` を実行してください。`NAS_CONFIG_TRUST_ALL=1` はこの gate を完全に bypass するため、CI / test 以外で使うべきではありません。

この gate は、既に信頼した設定や agent が利用する capability を無害化するものではありません。何を mount し、どの socket、rule、approval を許すかは、[機能別リスク](../risks/) と [推奨設定](../recommendations/) で個別に確認してください。

## コンテナ境界の範囲

コンテナ layer 内だけの変更は session 終了後に残りませんが、workspace と writable bind mount の変更は host に残ります。コンテナ内 agent は host UID/GID に合わせて動くため、書込み可能に渡した実体には host user として変更を加えられます。Docker の namespace、sidecar 分離、proxy authorization は重要な層ですが、脆弱性、誤った mount、許可済み broker capability、同一 host の信頼できない利用者までを自動で防ぐ保証ではありません。

## 関連ページ

- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) — workspace view と writable mount
- [ネットワーク制御](/nix-agent-sandbox/features/network/) — upstream への HTTP(S) 認可
- [コンテナポート公開](/nix-agent-sandbox/features/port-bind/) — host loopback から container service への relay
- [HostExec](/nix-agent-sandbox/features/hostexec/) — socket の役割と rule
- [UI daemon](/nix-agent-sandbox/features/ui/) — host-local control surface
