---
title: Nix 統合
description: ホストの nix-daemon をソケット経由でコンテナから利用する
sidebar:
  order: 1
---

`nix.enable` を有効にすると、ホストの nix daemon をソケット経由でコンテナから利用できるようになります。コンテナ側に Nix を入れておかなくても、`nix develop` や `nix run` で必要な開発環境やツールをその場でインストールできるのが利点です。

:::caution[リスク]
`nix.mountSocket = true` は実質的にホストユーザーと同等の権限をコンテナに与えます。詳細は[セキュリティ → 設定により隔離が緩和されるもの](/nix-agent-sandbox/security/#設定により隔離が緩和されるもの)を参照してください。
:::
