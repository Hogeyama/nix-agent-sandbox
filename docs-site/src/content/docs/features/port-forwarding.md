---
title: localhost ポート転送
description: コンテナから明示したホスト loopback サービスへ接続する
---

## どんな機能？

`network.proxy.forwardPorts` は、ホストの `127.0.0.1:<port>` にあるサービスを、コンテナ内の同じ `localhost:<port>` として到達可能にします。各 session は TCP を直接公開せず、per-session の Unix socket relay を通ります。ホストのサービスを `0.0.0.0` に bind し直す必要はありません。

コンテナ内の開発サーバーをホストから開く場合は方向が逆です。[コンテナポート公開](/nix-agent-sandbox/features/port-bind/)の `nas network bind` を使います。

## いつ使う？

ローカル開発 API、DB、観測用 receiver をコンテナ内のツールから使うときだけ指定します。ホストのサービスへ接続する必要がなければ、空のままにしてください。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `network.proxy.forwardPorts` | 空 | 同じ番号で中継する host loopback port の一覧。 |
| `18080` | 使用不可 | nas の内部 authentication proxy 用の予約 port。 |

## 最小の設定例

```pkl
network {
  proxy {
    forwardPorts { 5432; 8080 }
  }
}
```

この設定ではコンテナの `localhost:5432` はホストの `127.0.0.1:5432`、`localhost:8080` はホストの同番号へ relay されます。重複した port と `18080` は設定エラーです。

## 注意点・セキュリティへの影響

forward port はネットワークの HTTP scope 認可ではありません。指定した host service が認証なしなら、コンテナ内のエージェントはその service の権限で操作できます。開発 DB、管理 UI、local daemon は特に慎重に選び、不要になった port は削除してください。

ホストへ届く経路は明示した Unix socket relay に限られます。これは host TCP port 全体をコンテナへ公開する設定ではありませんが、指定した port のアクセス制御を置き換えるものでもありません。

[localhost ポート転送のリスク](/nix-agent-sandbox/security/risks/#port-forwarding)で、relay と service authority の違いを確認してください。

## 関連ページ

- [コンテナポート公開](/nix-agent-sandbox/features/port-bind/) — コンテナの service を host loopback で開く逆方向の relay
- [ネットワーク制御](/nix-agent-sandbox/features/network/) — 外向き HTTP(S) の scope / rule 認可
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `ProxyConfig.forwardPorts` の全定義
