---
title: Docker in Docker
description: rootless DinD sidecar による隔離 Docker 環境
---

## どんな機能？

`docker.enable` は session 専用の `docker:dind-rootless` sidecar を起動し、agent コンテナにその daemon への `DOCKER_HOST` を渡します。agent は host Docker daemon ではなく、この隔離された Docker 環境を使います。

## いつ使う？

agent に image build、テスト用コンテナ、Compose などを実行させるときに有効にします。Docker を使わない profile は既定の `enable = false` のままにしてください。host には nas 自身が sidecar を起動・管理するための Docker CLI / daemon が必要です。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `docker.enable` | `false` | session 専用の rootless DinD sidecar を起動する。 |
| `docker.shared` | `false` | 後方互換のためだけに残る deprecated field。`true` は使用できない。 |

## 最小の設定例

session ごとに独立した sidecar を使う例です。session 終了時に sidecar と一時 volume は teardown されます。

```pkl
docker = new DockerConfig {
  enable = true
}
```

`docker.shared` は以前の設定との読み込み互換性のためだけに残っています。`docker.enable = true` と `docker.shared = true` を併用すると validation error になります。古い profile に `shared` があれば、その field を削除してください。

## session state と pull cache のライフサイクル

DinD daemon、image・container などの mutable Docker/containerd state、DinD data volume、agent と共有する一時 volume は session 専用です。通常の session teardown は DinD sidecar と二つの volume に加え、その session の `registry-mirror` sidecar も削除します。異常終了などで unused resource が残った場合は [`nas container clean`](/nix-agent-sandbox/operations/maintenance/) で回収できます。

一方、public Docker Hub の blob と manifest は Docker volume `nas-registry-cache` に保存され、後の session でも再利用されます。共有されるのはこの pull cache だけで、DinD daemon、mutable state、private registry の image は session 間で共有されません。`nas container clean` もこの cache volume は意図的に残します。

Docker Hub pull はまず session 専用の `registry-mirror` を使います。cache miss では mirror からその session の proxy と network authorization を通って upstream へ request するため、scope / rule の allow または review approval が必要です。cache hit は upstream request を発生させないため、新しい network approval も発生しません。mirror を起動できない場合は、同じ session proxy を使う direct pull に fallback します。

## 注意点・セキュリティへの影響

sidecar は rootless Docker daemon ですが、起動する sidecar コンテナ自体には `--privileged` が必要です。この権限は agent コンテナへは渡りません。agent は `tcp://<sidecar>:2375` の `DOCKER_HOST` と共有一時 volume を受け取るだけで、`docker.enable` によって host の `/var/run/docker.sock` は自動で mount されません。

sidecar は起動後に session の内部 network へ接続され、既定 bridge から切り離されます。egress は session proxy を経由します。

cache miss や direct pull の request では、まず `network.scopes` の `targets` に一致する scope が選択され、その scope 内で rule の `onMatch` または scope の `fallback` が `allow` となるか、`review` で承認される必要があります。どの scope の target にも一致しない registry は `network.fallback` の `review` または `deny` で処理されます。最終的に拒否されると proxy は `403 Forbidden` を返し、pull は失敗します。

privileged sidecar と永続 pull cache の範囲は、[Docker in Docker のリスク](/nix-agent-sandbox/security/risks/#dind)を参照してください。

## 関連ページ

- [ネットワーク制御](/nix-agent-sandbox/features/network/) — sidecar を含む egress の認可
- [localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/) — host の開発サービスが必要な場合の明示的な経路
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `DockerConfig` の全定義
