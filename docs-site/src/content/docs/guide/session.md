---
title: セッション管理（dtach）
description: dtach で複数ターミナルから同じセッションに attach する
sidebar:
  order: 7
---

`session.multiplex = true` にすると、nas プロセス全体（プロキシ等を含む）が dtach セッション内で起動されます。これにより複数のターミナルから同じセッションに attach でき、detach してもコンテナやプロキシは動き続けます。
このセッションには[UI](/nix-agent-sandbox/operations/ui/) からも attach して操作が可能です。

詳細は[運用コマンド → セッションの管理](/nix-agent-sandbox/operations/commands/#セッションの管理)を参照してください。
