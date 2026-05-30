---
title: ホストの localhost ポート転送
description: コンテナからホストの loopback ポートへ到達する
sidebar:
  order: 4
---

ホスト側で動かしているローカル開発サーバーや DB に、コンテナの中から `localhost:<port>` でそのまま接続したいというケースがあります。`network.proxy.forwardPorts` を設定すると、Unix domain socket を介してホストに relay することによってこれを実現できます。ホスト側のサービスを `0.0.0.0` で公開する必要はなく、`127.0.0.1` に bind したままコンテナから到達できます。

内部機構の詳細と注意点は[設定により隔離が緩和されるもの](/nix-agent-sandbox/security/#設定により隔離が緩和されるもの)を参照してください。
