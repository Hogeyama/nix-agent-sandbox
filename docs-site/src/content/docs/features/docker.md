---
title: Docker in Docker
description: rootless DinD sidecar による隔離 Docker 環境
---

## どんな機能？

`docker.enable` は `docker:dind-rootless` の sidecar を起動し、agent コンテナにその daemon への `DOCKER_HOST` を渡します。agent は host Docker daemon ではなく、この隔離された Docker 環境を使います。

## いつ使う？

agent に image build、テスト用コンテナ、Compose などを実行させるときに有効にします。Docker を使わない profile は既定の `enable = false` のままにしてください。host には nas 自身が sidecar を起動・管理するための Docker CLI / daemon が必要です。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `docker.enable` | `false` | rootless DinD sidecar を起動する。 |
| `docker.shared` | `false` | `true` なら固定の sidecar を複数 session で再利用する。 |

## 最小の設定例

session ごとに独立した sidecar を使う例です。session 終了時に sidecar と一時 volume は teardown されます。

```pkl
docker = new DockerConfig {
  enable = true
  shared = false
}
```

`shared = true` にすると `nas-dind-shared` を再利用します。共有 sidecar は session 終了時に停止・削除されず、その session の network からだけ切り離されます。不要になった shared sidecar などの nas 管理リソースは `nas container clean` で掃除できます。

## 注意点・セキュリティへの影響

sidecar は rootless Docker daemon ですが、起動する sidecar コンテナ自体には `--privileged` が必要です。この権限は agent コンテナへは渡りません。agent は `tcp://<sidecar>:2375` の `DOCKER_HOST` と共有一時 volume を受け取るだけで、`docker.enable` によって host の `/var/run/docker.sock` は自動で mount されません。

sidecar は起動後に session の内部 network へ接続され、既定 bridge から切り離されます。egress は session proxy を経由します。共有モードでも各 session の network へ接続して終了時に切断するため、shared は「同じ daemon とデータを複数 session が使う」選択です。異なる信頼境界の作業を混ぜないでください。

DinD daemon による image pull も session proxy を経由します。まず `network.scopes` の `targets` に一致する scope が選択され、その scope 内で rule の `onMatch` または scope の `fallback` が `allow` となるか、`review` で承認される必要があります。どの scope の target にも一致しない registry は `network.fallback` の `review` または `deny` で処理されます。最終的に拒否されると proxy は `403 Forbidden` を返し、pull は失敗します。

privileged sidecar と shared daemon の範囲は、[Docker in Docker のリスク](/nix-agent-sandbox/security/risks/#dind)を参照してください。

## 関連ページ

- [ネットワーク制御](/nix-agent-sandbox/features/network/) — sidecar を含む egress の認可
- [localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/) — host の開発サービスが必要な場合の明示的な経路
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `DockerConfig` の全定義
