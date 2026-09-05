---
title: localhost ポート転送
description: コンテナからホストの localhost サービスへの接続
---

ホストの API や DB にコンテナから接続するには、`network.proxy.forwardPorts` にポート番号を指定します。ホストの `127.0.0.1:<port>` に、コンテナの `localhost:<port>` で接続できます。ホストのサービスを `0.0.0.0` で待ち受けさせる必要はありません。

逆に、コンテナの開発サーバーをホストから開く場合は[コンテナポート公開](/nix-agent-sandbox/features/port-bind/)を使います。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

```pkl
network {
  proxy {
    forwardPorts { 5432; 8080 }
  }
}
```

この設定ではコンテナの `localhost:5432` はホストの `127.0.0.1:5432`、`localhost:8080` はホストの同番号へ中継されます。重複したポートと `18080` は設定エラーです。

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `network.proxy.forwardPorts` | 空 | 同じ番号で中継するホストループバックポートの一覧。 |
| `18080` | 使用不可 | nas の内部認証プロキシ用の予約ポート。 |

## 注意点

この転送には HTTP(S) の scope・ルールによる認可は適用されません。指定したサービスが認証なしなら、エージェントもそのまま操作できます。DB や管理 API にはサービス側で認証を設定し、不要なポートは設定から削除してください。

[localhost ポート転送のリスク](/nix-agent-sandbox/security/risks/#port-forwarding)に権限の範囲をまとめています。

## 関連ページ

- [コンテナポート公開](/nix-agent-sandbox/features/port-bind/) — コンテナのサービスをホストループバックで開く逆方向の転送
- [ネットワーク制御](/nix-agent-sandbox/features/network/) — 外向き HTTP(S) の scope / ルール認可
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `ProxyConfig.forwardPorts` の全定義
