# network.allowlist 手動承認設計メモ (Envoy)

## 目的

`network.allowlist` の静的 allowlist 制御に加えて、allowlist 外アクセスをその場で保留し、ユーザーの `approve` / `deny` で同じ request を継続または拒否できるようにする。

要求は次の通り。

- shared proxy は必須
- request 単位で同期的に保留する
- ユーザー入力は agent と同じ TTY に割り込まない
- `docker.shared=true` もサポート対象とする
- HTTP/HTTPS explicit proxy を対象とする
- DinD の image pull は v1 では prompt 対象外とする

## 現状

現在の `network.allowlist` は Squid sidecar による静的制御で、未許可宛先は即 `403` になる。
`nas` 自体は最終的に `docker run --rm -it` を前面実行し、stdin/stdout/stderr を agent に直結しているため、同一 TTY に nas が割り込んで承認を取る設計は不向き。

関連箇所:

- `src/stages/proxy.ts`
- `src/stages/launch.ts`
- `src/stages/dind.ts`
- `src/docker/client.ts`

## 採用方針

基盤は Envoy を使う。

理由:

- explicit forward proxy を標準機能で持つ
- `ext_authz` で request ごとの同期 authorization ができる
- `CONNECT` を HTTP filter chain 上で扱える
- shared proxy 前提の拡張点が素直

一次資料:

- Envoy dynamic forward proxy:
  <https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/http/http_proxy.html>
- Envoy ext_authz:
  <https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_authz_filter.html>
- Envoy HTTP upgrades / `CONNECT`:
  <https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/http/upgrades.html>

## 全体アーキテクチャ

```text
Host
├─ nas process (session A)
│  └─ broker A (UDS)
├─ nas process (session B)
│  └─ broker B (UDS)
└─ shared runtime dir
   ├─ sessions/
   ├─ brokers/
   └─ pending/

Docker
├─ shared envoy container
├─ shared ext-authz router container
├─ session network A
│  ├─ agent A
│  ├─ envoy (attached)
│  └─ shared or dedicated dind (attached when needed)
└─ session network B
   ├─ agent B
   ├─ envoy (attached)
   └─ shared or dedicated dind (attached when needed)
```

役割分担:

- Envoy
  - shared data plane
  - explicit forward proxy
  - `CONNECT` tunnel の保持
  - ext_authz service への同期問い合わせ
- ext-authz router
  - shared control-plane edge
  - Envoy からの gRPC `CheckRequest` を受ける
  - session 識別を行い per-session broker に同期問い合わせする
  - Envoy へ allow / deny / challenge を返す
- per-session broker
  - session 固有の承認状態を持つ
  - pending request 管理
  - CLI からの approve / deny
  - 通知
- shared runtime dir
  - broker socket path
  - session registry
  - pending の可視化

## session 識別

### Proxy-Authorization

各 agent container には session 固有の proxy URL を渡す。

```text
http_proxy=http://sess_01JABC...:tok_01JDEF...@proxy:15001
https_proxy=http://sess_01JABC...:tok_01JDEF...@proxy:15001
```

この前提では ext-authz router は `Proxy-Authorization` を decode し、`session_id` と `token` で broker を引く。

期待:

- 多くの client は proxy URL の userinfo から `Proxy-Authorization` を送る
- `CONNECT` も HTTP filter chain を通るので ext_authz で扱える

## runtime dir

候補:

- 優先: `$XDG_RUNTIME_DIR/nas/network`
- fallback: `/tmp/nas-$UID/network`

構成:

```text
<runtime>/
├─ brokers/
│  └─ <session_id>.sock
├─ sessions/
│  └─ <session_id>.json
└─ pending/
   └─ <session_id>/
      └─ <request_id>.json
```

`sessions/<session_id>.json`

```json
{
  "version": 1,
  "session_id": "sess_01JABC...",
  "token_hash": "sha256:...",
  "broker_socket": "/run/user/1000/nas/network/brokers/sess_01JABC....sock",
  "profile_name": "test",
  "allowlist": ["github.com"],
  "created_at": "2026-03-15T10:00:00Z",
  "pid": 12345
}
```

ルール:

- token 生値は保存しない
- 書き込みは temp file + atomic rename
- directory permission は `0700`
- runtime dir は shared Envoy / ext-authz router にだけ mount する

## token 設計

proxy credentials:

- username: `session_id`
- password: `token`

生成方針:

- `session_id` は表示用の可読 ID
- `token` は CSPRNG で生成した 32 bytes 以上のランダム値
- registry には `SHA-256(token)` だけ保存する

auth-router の認証条件:

- `session_id` が registry に存在する
- `token_hash(password)` が registry の `token_hash` と一致する

一致しなければ deny。

## request key

approval scope の既定は `host + port` とする。

例:

- `api.openai.com:443`
- `registry.npmjs.org:80`

理由:

- `CONNECT` request には scheme が明示されない
- `host + port` なら forward request と `CONNECT` の両方で一貫する
- 将来必要なら補助情報として `request_kind=forward|connect` を追加できる

pending group key:

- `session_id + host + port`

deny 連打防止:

- session 内 short negative cache を持つ
- key: `session_id + host + port`
- TTL: `30s`

## broker の責務

保持状態:

- `session_id`
- session allowlist
- approved destinations
- pending requests
- short negative cache
- notify state

`authorize` の流れ:

1. allowlist hit なら即 `allow`
2. approved destinations hit なら即 `allow`
3. short negative cache hit なら即 `deny`
4. 既存 pending group に一致すれば join
5. 新規 pending を作る
6. 通知する
7. `approve` / `deny` / timeout を待つ
8. `deny` なら short negative cache を更新する
9. 待機中 request 全員へ同じ decision を返す

## Envoy 構成

### image

- stable を pin する
- 例: `envoyproxy/envoy:v1.37.1`

### listener / filter chain

- port: `15001`
- `HttpConnectionManager`
- explicit proxy として absolute-form HTTP request と `CONNECT` を受ける
- `upgrade_configs` で `CONNECT` を有効化する

filter 順序:

1. `ext_authz`
2. `dynamic_forward_proxy`
3. `router`

理由:

- deny request に DNS 解決や upstream 接続をさせない

### timeout 方針

- `request_timeout: 0s`
- route `timeout: 0s`
- route `idle_timeout: 0s`
- `stream_idle_timeout: 0s`
- ext_authz gRPC timeout: `300s`

理由:

- 承認待ちや長時間 `CONNECT` を途中で切らない
- route `timeout` の未指定デフォルトは 15s なので必ず明示する

### ext_authz cluster

- gRPC upstream
- `failure_mode_allow: false`
- HTTP/2 を明示する

```yaml
- name: ext_authz_router
  connect_timeout: 1s
  type: STRICT_DNS
  typed_extension_protocol_options:
    envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
      "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
      explicit_http_config:
        http2_protocol_options: {}
  load_assignment:
    cluster_name: ext_authz_router
    endpoints:
    - lb_endpoints:
      - endpoint:
          address:
            socket_address:
              address: nas-ext-authz
              port_value: 9001
```

### 設定スケッチ

```yaml
static_resources:
  listeners:
  - name: forward_proxy
    address:
      socket_address:
        address: 0.0.0.0
        port_value: 15001
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: forward_proxy
          common_http_protocol_options:
            idle_timeout: 0s
          request_timeout: 0s
          stream_idle_timeout: 0s
          route_config:
            name: local_route
            virtual_hosts:
            - name: proxy
              domains: ["*"]
              routes:
              - match:
                  connect_matcher: {}
                route:
                  cluster: dynamic_forward_proxy_cluster
                  timeout: 0s
                  idle_timeout: 0s
              - match:
                  prefix: "/"
                route:
                  cluster: dynamic_forward_proxy_cluster
                  timeout: 0s
                  idle_timeout: 0s
          upgrade_configs:
          - upgrade_type: CONNECT
          http_filters:
          - name: envoy.filters.http.ext_authz
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
              transport_api_version: V3
              failure_mode_allow: false
              grpc_service:
                envoy_grpc:
                  cluster_name: ext_authz_router
                timeout: 300s
          - name: envoy.filters.http.dynamic_forward_proxy
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig
              dns_cache_config:
                name: nas_dns_cache
                dns_lookup_family: V4_ONLY
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:
  - name: dynamic_forward_proxy_cluster
    connect_timeout: 5s
    lb_policy: CLUSTER_PROVIDED
    cluster_type:
      name: envoy.clusters.dynamic_forward_proxy
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig
        dns_cache_config:
          name: nas_dns_cache
          dns_lookup_family: V4_ONLY
  - name: ext_authz_router
    connect_timeout: 1s
    type: STRICT_DNS
    typed_extension_protocol_options:
      envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
        "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
        explicit_http_config:
          http2_protocol_options: {}
    load_assignment:
      cluster_name: ext_authz_router
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address:
                address: nas-ext-authz
                port_value: 9001
```

## ext-authz router プロトコル

auth-router は Envoy gRPC Authorization API を実装する。

### Envoy -> auth-router

受け取る情報:

- request headers
- `:method`
- `:authority`
- `Proxy-Authorization`

抽出:

- `CONNECT`: target は `:authority`
- 通常 proxy request: absolute URI または `Host` / `:authority`

処理:

1. `Proxy-Authorization` を decode
2. `session_id` / `token` を検証
3. target を正規化
4. per-session broker に同期問い合わせ
5. allow 時は `Proxy-Authorization` を upstream に流さないよう `headers_to_remove` を返す
6. allow / deny / challenge を Envoy `CheckResponse` に変換する

### auth-router -> broker

transport:

- Unix domain socket
- JSON Lines
- v1 は `1 request = 1 connect`

request:

```json
{
  "version": 1,
  "type": "authorize",
  "request_id": "req_01J...",
  "session_id": "sess_01JABC...",
  "target": {
    "host": "api.openai.com",
    "port": 443
  },
  "method": "CONNECT",
  "request_kind": "connect",
  "observed_at": "2026-03-15T10:00:30Z"
}
```

response:

```json
{
  "version": 1,
  "type": "decision",
  "request_id": "req_01J...",
  "decision": "allow",
  "scope": "host-port",
  "reason": "approved-by-user"
}
```

deny:

```json
{
  "version": 1,
  "type": "decision",
  "request_id": "req_01J...",
  "decision": "deny",
  "message": "denied-by-user"
}
```

## CLI / UX

CLI:

```text
nas network pending
nas network approve <session-id> <request-id> [--scope once|host-port|host]
nas network deny <session-id> <request-id>
nas network gc
```

通知優先順位:

1. `tmux display-popup`
2. `notify-send`

`prompt.notify: auto` はこの順序を意味する。

通知例:

```text
[nas] Pending network approval: sess_01JABC... api.openai.com:443
[nas] Run: nas network approve sess_01JABC... req_01J...
```

## session lifecycle

### 起動時

1. `session_id` と `token` を生成
2. broker socket を起動
3. session registry を書く
4. shared Envoy / ext-authz router を起動または再利用
5. session network を用意する
6. Envoy を session network に attach する
7. shared DinD を使う場合は DinD も session network に attach する
8. credentials 付き proxy env var を agent container に渡す
9. agent を通常どおり `docker run` で起動する

補足:

- この案では container IP 登録が不要なので、`docker create -> inspect -> start -> attach` への変更は必須ではない
- 既存の `docker run` 前面実行を維持できる可能性が高い
- session 起動時に stale registry / pending を opportunistic GC する

### 終了時

1. session registry を削除
2. broker socket を閉じる
3. Envoy を session network から detach
4. shared DinD を使う場合は DinD も session network から detach
5. session network を削除

shared Envoy / ext-authz router 自体は残す。

### shared DinD の ownership

`docker.shared=true` は prompt 有効時もサポートする。
ownership は分離する。

- `DindStage`
  - shared DinD コンテナ本体の起動・停止
  - bridge 側の初期接続
  - `DOCKER_HOST` 注入
- prompt 側ステージ
  - session network ごとの shared DinD attach / detach

これにより session teardown では shared DinD 本体は残し、その session network からだけ切り離す。

## failure policy

- ext_authz router 到達不能
  - deny
  - `failure_mode_allow: false`
- credentials なし
  - まず `407 Proxy Authentication Required`
  - 再試行で credentials が来れば続行
  - それでも来なければ deny
- broker timeout
  - pending timeout 後 deny
- stale session registry
  - deny
  - `nas` 起動時 / `nas network pending` 実行時 / `nas network gc` で掃除
- user 不在
  - timeout まで pending
  - timeout 後 deny

## セキュリティ注意

- `Proxy-Authorization` は upstream に流さない
  - ext-authz の `headers_to_remove` を第一候補にする
  - packet capture で実確認する
- dynamic forward proxy は proxy から到達可能な宛先へアクセスされうる
  - v1 では IP literal, localhost, loopback, link-local, metadata endpoint, private RFC1918 / ULA を deny default にする
  - hostname -> private IP 解決の厳密対策は未解決
- runtime dir は `0700`
- broker socket は owner only

参考:

- dynamic forward proxy warning:
  <https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/dynamic_forward_proxy_filter>

## config 案

```yaml
profiles:
  test:
    network:
      allowlist:
        - github.com
      prompt:
        enable: true
        timeout-seconds: 300
        default-scope: host-port
        notify: auto
```

型案:

```ts
interface NetworkPromptConfig {
  enable: boolean;
  timeoutSeconds: number;
  defaultScope: "once" | "host-port" | "host";
  notify: "auto" | "tmux" | "desktop" | "off";
}
```

## nas への実装差分

新規:

- `src/network/envoy_auth_router.ts`
- `src/network/broker.ts`
- `src/network/registry.ts`
- `src/network/protocol.ts`
- `src/network/notify.ts`
- `src/docker/envoy/`

変更:

- `src/config/types.ts`
- `src/config/validate.ts`
- `src/pipeline/context.ts`
- `src/stages/proxy.ts` または prompt 用新ステージ
- `src/stages/dind.ts`
- `src/stages/launch.ts` または env var 注入周り
- `src/docker/client.ts`
- `src/cli.ts`
- `README.md`

## POC 順序

### Phase 1

- Envoy standalone 起動
- `CONNECT` + dynamic forward proxy 疎通
- ext_authz gRPC で allow / deny
- `CONNECT` を 300s 近く保留しても timeout しないことを確認

### Phase 2

- `curl`, `git`, `npm`, `pip`, `cargo` で `Proxy-Authorization` が届くことを確認
- `407` 後の credentials 再試行を client 別に確認
- `Proxy-Authorization` が upstream へ漏れないことを packet capture で確認

### Phase 3

- per-session broker
- CLI `pending|approve|deny`
- pending 中 request の resume

### Phase 4

- nas pipeline へ統合
- shared Envoy / shared DinD lifecycle
- E2E テスト

## open questions

- `headers_to_remove` で `Proxy-Authorization` を確実に除去できるか
- hostname -> private IP 解決の扱いを v1 でどこまで詰めるか
- auth-router を shared container / Envoy 同居 / host process のどれに置くか

## 結論

この設計では、

- shared proxy は 1 個の Envoy で維持する
- session 固有状態は per-session broker に閉じ込める
- request 単位の同期承認は ext_authz で実現する
- session 識別は `Proxy-Authorization` による credentials routing を使う
- `docker.shared=true` も session network attach / detach で両立させる

これにより、shared proxy 前提のまま「その場で保留して通す」を実現できる。

# Envoy ベース手動承認ネットワーク制御 実装詳細計画 v4

## Summary

- Squid ベースの静的 allowlist 制御を、shared Envoy + shared auth-router + per-session broker 構成へ置き換える。
- network.allowlist の静的許可と network.prompt の動的承認を同じ broker 判定経路に統一する。
- DinD は従来どおり DindStage が本体 lifecycle を持ち、prompt/proxy 側は session network への attach/detach だけを担当する。
- v1 の auth-router は gRPC ではなく HTTP ext_authz over UDS を採用する。Deno 単体で host daemon として実装でき、x-envoy-auth-headers-to-remove で Proxy-Authorization 除去も表現できる。
- v1 の session 識別は Proxy-Authorization: Basic ... のみを使い、credentials が来ない client に対する fallback routing は実装しない。

## Trial Findings

- v3の試行で、設計上は独立に見える変更でも実装上は強く結合している箇所が分かった。次回は以下を「同一判断単位」で扱う。
- auth-router transport の決定
  - gRPC と HTTP ext_authz は差し替え可能な詳細ではない。Envoy 設定、auth-router 実装、資格情報除去方法、integration test が全部連動する。
  - v1 は HTTP ext_authz over UDS に固定する。再検討しない。
- Envoy 資材追加時の必須同時更新
  - src/docker/envoy/ を追加したら、computeEmbedHash、DockerBuildStage の書き出し対象、deno compile --include、docker_client_test の embed 対象一覧を同じコミットで更新する。
  - この 4 点を分けると build 警告やテストが中途半端に壊れる。
- network.prompt 追加時の必須同時更新
  - config 型追加だけでは不十分で、validate、config merge、ExecutionContext、Profile を直書きしているテスト fixture まで同時に直す必要がある。
  - 次回は feat(config) コミットの中で type-check を通すまで終えない。
- ProxyStage 置換時の必須同時更新
  - src/stages/proxy.ts の置換と tests/proxy_stage_test.ts の差し替えは同一コミットにする。
  - tests/cli_e2e_test.ts の Squid 前提も同じタイミングで削除するか、一時的に ignore 条件を切り分ける。
  - 旧 export 名 computeAllowlistHash / generateSquidConfig を先に消すと type-check が壊れる。
- CLI 追加時の必須同時更新
  - nas network サブコマンドを足すと、findFirstNonFlagArg、usage、CLI parse test、help text も同時更新が必要になる。
  - hidden internal subcommand 用 flag も parse スキップ対象に入れる。
- 実装順の学び
  - broker / registry / auth-router / proxy / cli を並行に触るとコミット粒度が崩れる。
  - 次回は config → docker assets → network core → network tests → proxy → cli → dind → e2e の順を崩さない。

## Reimplementation Guardrails

- 各コミットの完了条件
  - deno check main.ts
  - deno test --allow-all --no-run
  - 対象コミットで触れた旧前提の grep が 0 件になること
- grep で確認する旧前提
  - rg -n "ubuntu/squid|generateSquidConfig|computeAllowlistHash" src tests
  - rg -n "grpc_service|ext_authz gRPC" src/docker/envoy src/network README.md tests
  - rg -n "network: \\{ allowlist: \\[\\] \\}" tests
- Docker 実行を含む integration/E2E に入る前提
  - CLI parse と config 系の no-run type-check が通っていること
  - hidden serve-auth-router が CLI から起動できること
  - shared Envoy の standalone 起動テストが先に通っていること
- 実装を途中で止める場合の保存単位
  - plan.md を先に更新してからコードに触る
  - コミット予定単位をまたいだ横断変更は stash ではなく破棄前提で扱う

## Parent / Child Codex Strategy

### Parent Responsibilities

- 親 Codex は plan.md の更新、コミット境界の維持、最終検証、コミット作成だけを担当する。
- 親 Codex は子 Codex に「1コミット相当」の範囲だけを渡す。複数コミット相当の依頼はしない。
- git commit / git restore は親 Codex だけが行う。

### Child Contract

- 子 Codex の起動引数は固定する。
  - --ask-for-approval never
  - --sandbox danger-full-access
- 子 Codex は割り当てられたパス以外を編集しない。
- 子 Codex は git commit / git restore / git reset / git checkout を実行しない。
- 子 Codex は task 完了後に以下だけを返す。
  - 変更したファイル
  - 実行した検証コマンド
  - 未解決点
- 子 Codex が途中で設計変更を提案したくなっても、plan.md を直接広く書き換えず、親に判断を返す。

### Child Handoff Template

- 親 Codex は子 Codex に毎回以下を渡す。
  - 目的
  - 編集可能パス
  - 変更禁止事項
  - 完了条件
  - 実行してよい検証コマンド
  - 最終報告形式
- 例:
  - 目的: feat(config) コミット相当を完了する
  - 編集可能パス: src/config/, src/pipeline/context.ts, src/network/protocol.ts, tests/config_*, tests/merge_test.ts
  - 変更禁止事項: それ以外のパス編集、git 操作、fmt/lint
  - 完了条件: deno check main.ts と deno test --allow-all --no-run が通る
  - 最終報告形式: files / commands / unresolved

### Recommended Child Split

- commit 1 は子 Codex に投げやすい。
  - config / context / protocol helper だけで閉じるため。
- commit 2 も子 Codex に投げやすい。
  - docker helper / envoy asset / embed hash に閉じるため。
- commit 3 と 4 は同一子または連続実行がよい。
  - registry / broker / auth-router とその unit/integration test が密結合だから。
- commit 5 以降は親 Codex 主導がよい。
  - proxy / cli / dind / e2e は横断依存が増え、途中状態が壊れやすいため。

## Implementation Changes

### 1. Docker / Envoy 基盤

- src/docker/envoy/ を追加し、Envoy 設定テンプレートを置く。listener は 0.0.0.0:15001、dynamic_forward_proxy と ext_authz を有効化し、すべての timeout は 0s、
  ext_authz timeout は 300s に固定する。
- Envoy から auth-router への接続は runtime dir 内の UDS を使う。Envoy 設定は pipe: /nas-network/auth-router.sock を参照し、shared Envoy container に runtime dir を
  bind mount する。
- ext_authz は grpc_service ではなく http_service を使う。Envoy は /authorize へ同期 POST し、allowed_headers は Proxy-Authorization / Host / x-request-id に絞る。
- Envoy は headers_to_add で x-nas-original-method, x-nas-original-authority, x-nas-original-url を auth-router に渡す。CONNECT と forward request の target 正規化はこのヘッダ群だけで決まる形にする。
- src/docker/client.ts は detached container API を拡張し、network、mounts、publishedPorts、labels、entrypoint、command を扱えるようにする。docker network connect は
  alias 指定をサポートする。
- DockerBuildStage / computeEmbedHash / deno compile --include は src/docker/envoy/ を含める。Envoy 資材追加と埋め込みハッシュ更新は同一コミットで行う。
- nas 管理 resource kind に envoy と session-network を追加する。container clean は shared Envoy を sidecar として認識し、非利用時だけ stop/rm する。

### 2. protocol / registry / broker / notify

- src/network/protocol.ts に以下を定義する。
- ApprovalScope = "once" | "host-port" | "host"
- SessionCredentials
- NormalizedTarget { host, port }
- AuthorizeRequest
- DecisionResponse
- PendingEntry
- SessionRegistryEntry
- target 正規化は以下で固定する。
- host は lowercase 化し trailing dot を除去する。
- CONNECT は :authority を host:port として扱う。
- forward request は absolute URI を優先し、なければ Host / :authority を使う。
- port 省略時は http=80、https=443 を補完する。
- 空 host、0 以下 port、不正 authority は deny 扱いにする。
- v1 の deny-default 宛先は broker 前で遮断する。
- localhost
- loopback
- link-local
- RFC1918
- ULA
- 169.254.169.254
- metadata.google.internal
- 上記の IP literal / 既知 hostname
- hostname の DNS 解決先が private IP かどうかまでは v1 では見ない。
- src/network/registry.ts は runtime dir を $XDG_RUNTIME_DIR/nas/network 優先、fallback を /tmp/nas-$UID/network とし、すべて 0700 で作成する。構成は sessions/,
  pending/, brokers/, auth-router.sock, auth-router.pid, envoy.yaml とする。
- registry write は temp file + atomic rename で行う。stale 判定は pid 不在、または broker socket 不在で行う。
- src/network/broker.ts は per-session の UDS JSON Lines server とし、request type は authorize, list_pending, approve, deny を持つ。
- authorize の流れは固定する。
- allowlist hit なら即 allow
- approved cache hit なら allow
- negative cache hit なら deny
- session_id + host + port の既存 pending があれば join
- なければ pending 作成、通知、timeout 待ち
- timeout 後は deny し negative cache を 30 秒更新
- approve scope は以下で固定する。
- once: 同一 request_id のみ解放
- host-port: 同一 host + port を session 終了まで許可
- host: 同一 host の全 port を session 終了まで許可
- approvals は broker メモリ保持のみで、永続化しない。
- src/network/notify.ts は auto で tmux display-popup を試し、失敗時に notify-send、両方不可なら no-op にする。stderr へは何も出さない。

### 3. auth-router

- src/network/envoy_auth_router.ts は Envoy ext_authz HTTP service を実装する。
- Proxy-Authorization を decode し、username を session_id、password を token として扱う。
- registry には token 生値を保存せず、sha256:<hex> のみ保存する。router 側で password を hash して照合する。
- credentials 不在または不正時は 407 Proxy Authentication Required と Proxy-Authenticate: Basic realm="nas" を返す。
- valid credentials 取得後は target を正規化し、対応 broker に同期問い合わせする。
- allow 時は 200 を返し、x-envoy-auth-headers-to-remove: proxy-authorization を付けて upstream へ資格情報を流さない。
- stale session、missing broker、router 内部エラーは 403 deny にする。failure_mode_allow は使わない。
- host daemon 実装は node:http 互換 API で UNIX socket を listen する。proto vendor / gRPC runtime 追加は行わない。
- auth-router は host process とし、公開コマンドではなく hidden internal subcommand nas network serve-auth-router --runtime-dir <dir> で起動する。prompt 有効セッショ
  ン開始時に ensureAuthRouterDaemon() で daemonize し、runtime dir の pid/socket で再利用する。

### 4. Config / Context / CLI

- network.prompt を追加する。既定値は以下で固定する。
- enable: false
- timeout-seconds: 300
- default-scope: host-port
- notify: auto
- src/config/types.ts と src/config/validate.ts は上記型と default を追加する。network の merge は既存どおり shallow merge とし、prompt も field 単位でマージされる前
  提に揃える。
- ExecutionContext に以下を追加する。
- sessionId
- networkRuntimeDir
- networkPromptToken
- networkPromptEnabled
- networkBrokerSocket
- networkProxyEndpoint
- createContext() で sessionId を生成する。形式は sess_ prefix + 12 文字のランダム hex とする。token は proxy 有効時のみ 32 bytes CSPRNG から生成する。
- src/cli.ts に public subcommand を追加する。
- nas network pending
- nas network approve <session-id> <request-id> [--scope once|host-port|host]
- nas network deny <session-id> <request-id>
- nas network gc
- pending は session_id request_id target state age を 1 行ずつ表示する。
- approve / deny は broker socket に接続し、成功時は 0、対象なし・stale session・broker 不在時は 1 を返す。
- gc は stale session file、orphan pending dir、dead broker socket、dead auth-router pid/socket を削除する。

### 5. Pipeline 統合

- ProxyStage を Envoy ベースへ置換する。skip 条件は allowlist=[] かつ prompt.enable=false のときだけにする。
- ProxyStage.execute() は以下を順に行う。
- runtime dir 作成と stale GC
- prompt/proxy 用 token 生成
- per-session broker 起動
- session registry 書き込み
- shared auth-router daemon の ensure
- shared Envoy container の ensure
- session network nas-session-net-<sessionId> の作成
- Envoy をその network に nas-envoy alias 付きで attach
- DinD 有効時は DinD container も同 network に attach
- ctx.dockerArgs の --network を session network に置換
- credentials 付き proxy env を注入
- proxy env は以下で固定する。
- http_proxy
- https_proxy
- HTTP_PROXY
- HTTPS_PROXY
- 値は http://<sessionId>:<token>@nas-envoy:15001
- no_proxy / NO_PROXY は localhost,127.0.0.1 に加え、DinD 有効時のみ DinD container 名を足す。
- broker の allow 判定は prompt 有無で分岐させず共通化する。prompt.enable=false の場合は allowlist 外アクセスを pending 化せず即 deny するだけにする。
- DindStage は shared DinD 本体 lifecycle を現状維持する。prompt/proxy 有効時でも agent 起動 network は最終的に ProxyStage が session network に差し替える。
- teardown は以下で固定する。
- session registry 削除
- broker server 停止
- broker socket / pending dir 削除
- Envoy を session network から detach
- shared DinD を session network から detach
- session network 削除
- shared Envoy と shared auth-router daemon は残す
- 既存の Squid 前提テストは ProxyStage 置換コミットと同時に差し替える。tests/proxy_stage_test.ts と tests/cli_e2e_test.ts を途中状態で壊さない。

## Commit Plan

1. feat(config): add network prompt config, context fields, and pure protocol helpers

- src/config/types.ts / src/config/validate.ts / src/config/load.ts
- src/pipeline/context.ts
- src/network/protocol.ts
- config/merge/unit tests をここで更新する

2. feat(docker): add envoy assets, embed handling, and docker helper extensions

- src/docker/envoy/ 追加
- src/docker/client.ts の detached run / network attach API 拡張
- DockerBuildStage / computeEmbedHash / deno compile --include 更新
- nas resource kind に envoy / session-network 追加

3. feat(network): add registry, broker, notify, and auth-router HTTP service

- src/network/registry.ts
- src/network/broker.ts
- src/network/notify.ts
- src/network/envoy_auth_router.ts
- hidden serve-auth-router もこのコミットに含める

4. test(network): add protocol/broker/auth-router unit tests and standalone envoy integration tests

- target 正規化 / Proxy-Authorization decode / deny-default
- broker pending/approve/deny/timeout/state machine
- Envoy standalone 起動
- dynamic forward proxy の forward / CONNECT
- ext_authz allow / deny / 407

5. refactor(proxy): replace squid stage with envoy-based lifecycle and update cleanup logic

- src/stages/proxy.ts の全面置換
- shared Envoy ensure
- session network attach/detach
- credentials 付き proxy env 注入
- container clean を Envoy / session-network 前提へ更新
- tests/proxy_stage_test.ts をこのコミットで Envoy 版に差し替える

6. feat(cli): add public network commands and integrate session lifecycle into main execution path

- nas network pending|approve|deny|gc
- 通常起動経路で broker / registry / auth-router / Envoy ensure を接続
- teardown で registry/socket/network cleanup を実施

7. refactor(dind): support prompt session-network attach lifecycle

- src/stages/dind.ts の ownership を維持しつつ、prompt/proxy と併用できる状態へ調整
- shared DinD attach/detach の責務分離を確定

8. test(e2e): replace squid-based CLI E2E with envoy-based approval scenarios

- tests/cli_e2e_test.ts の Squid 前提を削除
- pending/resume
- deny
- timeout
- shared DinD attach/detach
- cleanup / gc

9. test(clients): validate proxy authorization behavior across supported clients

- curl, git
- 初回 407 と再送
- upstream への資格情報非漏洩確認

10. docs: document network prompt workflow

- README.md
- 新 config
- nas network 運用
- 既知制約

## Test Plan

- Unit
- network.prompt の default / validation / invalid enum 値
- target 正規化
- Proxy-Authorization decode
- private target deny table
- registry atomic write と stale GC
- broker の pending join / approve / deny / timeout / scope
- notify backend 選択
- Integration
- shared Envoy の standalone 起動
- dynamic forward proxy の forward / CONNECT 疎通
- ext_authz HTTP service の allow / deny / 407
- CONNECT を長時間保留しても timeout しないこと
- x-envoy-auth-headers-to-remove により upstream へ Proxy-Authorization が漏れないこと
- shared Envoy attach/detach
- shared DinD attach/detach
- Client compatibility
- curl
- git
- 各 client について、初回 407、credentials 再送、upstream 非漏洩を確認する。
- E2E
- allowlist 外アクセスが pending になる
- nas network pending で見える
- nas network approve 後に同一 request が継続する
- nas network deny で失敗する
- host-port scope が次回 request に効く
- timeout で deny される
- stale session が nas network gc で掃除される
- container clean が active な shared Envoy を残し、unused のみ削除する

## Assumptions / Defaults

- v1 auth-router は container ではなく host daemon とする。
- v1 auth-router transport は gRPC ではなく HTTP ext_authz over UDS とする。
- v1 は hostname の DNS 解決先 private IP 判定を行わない。
- v1 は Proxy-Authorization 以外の session 識別を持たない。
- v1 の approval は session lifetime のみ有効で、永続化しない。
- public CLI は pending|approve|deny|gc のみ追加し、auth-router 起動は hidden internal subcommand に閉じる。
