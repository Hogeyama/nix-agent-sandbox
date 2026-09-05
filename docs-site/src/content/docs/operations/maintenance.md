---
title: イメージ・作業環境の管理
description: Docker イメージの再構築、Worktree と未使用コンテナの削除
---

nas の Docker イメージの再構築と、終了後の作業環境の削除に使うコマンドです。

## イメージの再構築

既存イメージを削除して再ビルドします。

```sh
nas rebuild
```

`nas rebuild --force` は参照中のコンテナがあってもイメージを強制削除するため、先に該当セッションを終了してください。セッション自体を停止するコマンドではありません。

## Worktree の削除

まず対象を確認します。

```sh
nas worktree list
nas worktree list --format json
```

対象は、ディレクトリ名が `nas-` で始まる Git worktree です。nas が作成した記録ではなく名前で選ぶため、手動作成した同名形式の worktree も含まれます。

**削除前に、使用中のエージェントとコンテナを終了してください。** 使用中でも削除対象になります。ターミナルの切り離しは停止ではありません。また、`nas session list` は dtach のセッションだけを表示するため、一覧が空でもすべて停止したとは限りません。

確認後、対象の worktree を未コミットの変更ごと削除します。必要な変更を保存してから実行してください。ブランチは既定では残ります。

```sh
nas worktree clean
```

| オプション | 動作 |
| --- | --- |
| `-f`, `--force` | 確認を省略。 |
| `-B`, `--delete-branch` | 削除した worktree のブランチに加え、開始時点で worktree に属していなかったすべての `nas/*` ブランチも削除。 |

## 未使用コンテナの削除

`list` で名前、種類、稼働状態、開始時刻を確認します。

```sh
nas container list
nas container list --format json
```

`clean` は未使用の補助コンテナ、空のネットワーク、セッション用の一時ボリュームを削除します。

実行中のエージェントと、それが使用する補助コンテナは削除しません。公開 Docker Hub の取得キャッシュ `nas-registry-cache` も保持します。この使用中の判定は `worktree clean` にはありません。

```sh
nas container clean
```

## 関連ページ

- [Worktree](/nix-agent-sandbox/features/worktree/)
- [Docker in Docker](/nix-agent-sandbox/features/docker/)
- [異常終了後のデータ](/nix-agent-sandbox/security/limitations/#異常終了後のデータ)
