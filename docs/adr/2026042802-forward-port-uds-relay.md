---
Status: Accepted
Date: 2026-04-28
---

# ADR: forward-port を envoy CONNECT から per-session UDS relay に切替

## Context
profile の `forwardPorts` で宣言したポートは、agent コンテナ内のプロセス
が `127.0.0.1:<port>` で host loopback に届くようにする機能。従来は
local-proxy.mjs が envoy へ HTTP CONNECT トンネルを張り、envoy が
docker bridge 経由で host に出ていく経路を使っていた。

この経路は **host listener が docker bridge から到達可能であること** を
要求するため、利用者は dev server / DB / 各種ローカルサービスを
`0.0.0.0` に bind せざるを得ず、サンドボックス都合で host 側のバインド
を広げる構図になっていた。本来欲しいのは「host サービスは 127.0.0.1
のままで、サンドボックス内からだけアクセスできる」というセキュリティ
姿勢で、現状はそれと真逆だった。

## Decision

### 経路
forward-port トラフィックは **per-port Unix domain socket** を介して
流す。envoy / auth-router は forward-port では一切経由しない。

```
agent process  →  127.0.0.1:<port>  (no_proxy で raw TCP)
              →  local-proxy listener (container 内)
              →  /run/nas-fp/<port>.sock  (bind-mount)
              →  host nas relay (UDS listener)
              →  127.0.0.1:<port>  (host loopback)
```

**アクセス境界は UDS の bind-mount そのもの**。envoy の allowlist で
許可するレイヤは forward-port には不要になるため、planProxy が
`host.docker.internal:<port>` を allowlist に暗黙注入するロジックは
撤去する (profile が明示的に書いた entry は従来どおり尊重)。

### Host 側 relay (`src/network/forward_port_relay.ts`)
- Socket path は `<runtimeDir>/forward-ports/<sessionId>/<port>.sock`。
  per-session subdir に置くので並行 session が衝突せず、close() は
  サブツリーごと `rm -rf` できる。
- パーミッションは UDS ファイル `0o666` / 親ディレクトリ `0o700` の
  組み合わせ (auth-router と同じパターン)。uid mapping に依存せず
  container プロセスから接続でき、host の非 root user は親 dir に
  入れない。
- `ports=[]` は I/O を一切起こさず short-circuit (forward-ports root
  すら作らない)。caller が無条件に呼べる契約にすることで Effect
  チェーンを単一形に保つ。
- 重複ポートは I/O 前に reject (部分起動状態を残さないため)。
- `server.on("error")` は listen() 中だけでなく **listener の
  生涯ずっと** attach。listen 後の async error が unhandled に
  ならないようにする invariant。
- per-pair teardown は `error` (log のみ) と `close` (peer destroy +
  active set から drop) を分離し、意図を読めるようにする。
- chmod 失敗時は listener を畳んで socket file を消してから throw
  (chmod reject 時に listening server が leak しないため)。
- `close()` は `ERR_SERVER_NOT_RUNNING` 以外の `server.close` エラー
  を伝播 (idempotent close を保ちつつ silent swallow を避ける)。

### Container 側 (`src/docker/embed/local-proxy.mjs`)
- forward-port loop は `NAS_FORWARD_PORT_SOCKET_DIR` を読み、
  accept した client connection ごとに `<dir>/<port>.sock` に dial
  するだけ。CONNECT request 構築 / response 解析 / proxy 認証は
  forward-port 経路から削除。
- early-bytes の buffer-and-unshift パターンは保持。accept から UDS
  readiness までの間に到着するバイトを取りこぼさないため、および
  upstream 配線が将来変わっても契約を崩さないため。
- `NAS_FORWARD_PORTS` が非空なのに `NAS_FORWARD_PORT_SOCKET_DIR` が
  未設定なら warning を出して loop を skip する safety net を入れる
  (planProxy 側で env は常に set されるが、防御的に残す)。
- HTTP/HTTPS proxy CONNECT 経路は **無関係なので一切触らない**。
  `NAS_UPSTREAM_PROXY` も従来どおり必須。

### ProxyStage 配線
`ForwardPortRelayService` を `Context.Tag + Layer.succeed` の Live
/ Fake シェイプで追加 (sibling proxy services と同じ形)。
`runProxy` 内で **auth-router daemon と shared envoy listener の間に**
`Effect.acquireRelease` で `ensureRelays` を呼ぶ。配置は意図的で、
LIFO release により:
1. shared envoy listener を先に閉じて新規 agent traffic を止め、
2. その後 relays を閉じる (mid-flight forward-port 接続が途切れない)、
3. auth-router と runtime dir は relays が消えるまで生かす、

の順番が保証される。`ensureRelays` は `ports=[]` の no-op fast path
があるので **無条件に呼ぶ** (Effect チェーンを uniform に保つ)。

### plan 側の制約
forward-port が非空のときだけ per-port bind-mount と
`NAS_FORWARD_PORT_SOCKET_DIR=/run/nas-fp` env を吐く。空のコンテナ
は余計な mount / env を見ない。bind-mount 元のパスは relay モジュール
が公開する `forwardPortSocketPath(runtimeDir, sessionId, port)` ヘルパ
を plan / runtime 双方が叩くので、両者が drift しない。

### テストの DI seam
relay モジュールに full DI layer は導入しない。代わりに
`startSessionForwardPortRelays` が `@internal` underscore-prefixed の
`_relayFactory` seam を取り、デフォルトは本物の実装。partial-leak
rollback テストを deterministic にできる最小表面に絞る。

## Consequences
- host のサービスは `127.0.0.1` bind のままで OK。サンドボックス
  都合で `0.0.0.0` バインドを強要しない。
- forward-port のアクセス制御は UDS の bind-mount = container plan
  の管轄に閉じる。envoy allowlist には forward-port のエントリが
  暗黙注入されなくなる (user 明示は尊重)。
- `ProxyPlan` に `forwardPorts` フィールドが追加される。
- `host.docker.internal:host-gateway` の `--add-host` は envoy 起動
  オプションに残る (forward-port では未使用だが他の envoy traffic が
  依存しうる)。撤去は本 ADR の scope 外。
- `NAS_FORWARD_PORT_SOCKET_DIR` (container 側) と
  `<runtimeDir>/forward-ports/<sessionId>/` (host 側) が新しい
  runtime 上の規約として固定される。後者は session の `rm -rf`
  で一括掃除できる形に保つ。
- relay の lifetime は parent process の Effect scope に紐づく
  ため、SIGKILL / OOM 等で finalizer が走らないと UDS file が残る。
  既存の display GC と同じ「次回起動時に sweep」型の対処が必要に
  なれば追加するが、本 ADR ではそこまで踏み込まない。

## Rejected alternatives
- **CONNECT 経路のまま `0.0.0.0` バインドを利用者に要求**: 元々の
  動機がこの姿勢を否定すること。セキュリティ regression。
- **auth-router の daemon + pidfile パターンを再利用**: auth-router
  は session 横断で共有される常駐 daemon、forward-port relay は
  per-session。pidfile / supervise 機構を引き込む旨味がなく、
  parent process の bun async listener を `Effect.acquireRelease`
  で握る方が軽い。
- **relay モジュールに full DI layer を導入**: テストのために
  factory / clock / fs を全部抽象化するのは過剰。partial-leak
  rollback の deterministic 化に必要なのは relay 生成 1 点だけで、
  `_relayFactory` 1 seam で足りる。
- **`ensureRelays` を ports 非空時のみ条件付きで呼ぶ**: Effect
  チェーンに分岐が増えるだけで意味がない。`ports=[]` 側で no-op
  fast path を持つ方が呼び出し側を unconditional に保てる。
- **acquireRelease を envoy listener より先 (= 内側) に置く**:
  release LIFO で relays が先に閉じ、envoy が握っている in-flight
  connection が宙に浮く。envoy listener を先に閉じてから relays
  を閉じる順序にする必要がある。
- **forward-port も envoy allowlist に通す**: 経路に envoy が
  挟まらない以上 allowlist は無意味。残すと「効いていそうで
  効かない設定」になり混乱の元。暗黙注入は撤去、user 明示の
  `host.docker.internal:*` だけ verbatim に残す。
- **`envoy_service.ts` の `--add-host=host.docker.internal:host-gateway`
  を同時に削除**: 他の envoy traffic が依存している可能性があり、
  本 ADR で一緒に動かすと blast radius が広がる。別途必要に
  なってから扱う。
- **per-session subdir を持たず flat に
  `<runtimeDir>/forward-ports/<port>.sock` で運用**: 並行 session
  が同じ port を forward する組み合わせで衝突する。subdir 化と
  サブツリー単位の rm -rf がペアの設計。
