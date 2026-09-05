---
title: Docker in Docker
description: エージェント用 Docker 環境の設定とデータの保持期間
---

エージェントに Docker イメージのビルド、テスト用コンテナ、Compose を使わせるには `docker.enable = true` を設定します。セッション専用の Docker daemon を別コンテナで起動し、エージェントに接続先を渡します。ホストの Docker ソケットは共有しません。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

```pkl
docker = new DockerConfig {
  enable = true
}
```

`docker.enable = true` と `docker.shared = true` の併用は設定エラーです。古いプロファイルに `shared` があれば削除してください。

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `docker.enable` | `false` | セッション専用の Docker daemon を補助コンテナで起動。 |
| `docker.shared` | `false` | 廃止済みの互換フィールド。`true` は使用不可。 |

## データとキャッシュの保持期間

| 対象 | セッション終了後 |
| --- | --- |
| Docker daemon、作成したイメージ・コンテナ、作業用ボリューム | 通常の終了処理で削除。 |
| セッション専用の `registry-mirror` コンテナ | 通常の終了処理で削除。 |
| 公開 Docker Hub の取得キャッシュ `nas-registry-cache` | 次のセッションでも再利用。`nas container clean` でも保持。 |

非公開レジストリのイメージや、Docker の作業データはセッション間で共有しません。異常終了などで残った未使用コンテナは[管理コマンド](/nix-agent-sandbox/operations/maintenance/#未使用コンテナの削除)で削除できます。

キャッシュにないイメージの取得には、[ネットワーク制御](/nix-agent-sandbox/features/network/)で通信許可が必要です。拒否されると `403 Forbidden` で取得に失敗します。キャッシュから取得した場合は外部通信も新たな承認も発生しません。ミラーを起動できない場合は、同じセッションのプロキシを経由して直接取得します。

## 注意点

エージェント用の Docker daemon は rootless ですが、それを動かす補助コンテナには `--privileged` が必要です。エージェントのコンテナにはこの権限を渡しません。

補助コンテナはセッションの内部ネットワークに接続し、外向き通信にはプロキシを使います。[Docker in Docker のリスク](/nix-agent-sandbox/security/risks/#dind)も参照してください。

## 関連ページ

- [ネットワーク制御](/nix-agent-sandbox/features/network/) — Docker イメージ取得時の通信許可
- [localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/) — ホストの開発サービスが必要な場合の明示的な経路
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `DockerConfig` の全定義
