---
title: クイックスタート
description: 設定を作成して最初のエージェントを起動する
---

ここでは、エージェントと Docker を導入済みの Linux 環境で、プロジェクト専用の設定を作ります。

## 設定を生成する

作業したいリポジトリのルートで実行します。

```sh
cd /path/to/your-project
nas config init
```

このコマンドは `.nas/` とグローバル設定を生成し、今生成したプロジェクト設定を信頼済みとして記録します。既定の設定には `claude` と `codex` の profile があり、既定の profile は `claude` です。

## 起動する

```sh
nas
```

別の profile を使うときは、その名前を指定します。nas のオプションは profile 名より前に置き、profile 名より後ろの引数はエージェントへ渡されます。

```sh
nas codex
nas --worktree @ codex
nas codex -p "このリポジトリを調べて"
```

`--worktree` はこの起動だけに Git worktree を作るオプションで、`nas worktree` サブコマンドとは別の機能です。

生成された profile は最小限です。ネットワーク接続、追加マウント、HostExec などが必要になったときは、[設定の基本](../configuration/) を確認してから追加してください。
