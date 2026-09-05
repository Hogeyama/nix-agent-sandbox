---
title: Worktree
description: エージェントごとの作業フォルダーとブランチ
---

自分や別のエージェントの作業と分けたい場合は、Git worktree を使えます。nas は `.nas/worktrees/nas-<timestamp>/` とブランチ `nas/<timestamp>` を作り、そこでエージェントを起動します。Git リポジトリが必要です。

## 起動

一回だけ別の作業フォルダーで起動するには、基準ブランチを指定します。

```sh
nas -b main claude
```

`-b` / `--worktree` はプロファイル名より前に置きます。`@` は現在の `HEAD` を表します。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

毎回使用する場合は、基準ブランチと作成直後の準備を指定します。

```pkl
worktree = new WorktreeConfig {
  base = "main"
  onCreate = "bun install"
}
```

## 設定項目

| 設定・オプション | 既定 | 用途 |
| --- | --- | --- |
| `worktree.base` | — | 新しいブランチの基準ブランチ・コミット。`HEAD` は現在の HEAD。 |
| `worktree.onCreate` | — | worktree 作成後、そのディレクトリで `bash -c` 実行する準備コマンド。 |
| `-b`, `--worktree <branch>` | なし | 一回だけ worktree を有効にし、基準ブランチを指定する。`@` も `HEAD` として扱う。 |
| `--no-worktree` | なし | プロファイルの worktree 設定をその起動だけ無効にする。 |

## 注意点

既存の worktree がある場合は、再利用か新規作成を選べます。終了時には保存か削除を選びます。

未コミットの変更があれば、stash、変更を破棄して削除、保存を選べます。ブランチに固有のコミットがあれば、削除、基準ブランチへの cherry-pick、名前変更して保存を選べます。cherry-pick に失敗したブランチは残ります。

`onCreate` はホストで `bash -c` として実行されます。エージェントが変更できるスクリプトを指定すると、ホストでもその変更が実行されます。

終了後の一括削除は[イメージ・作業環境の管理](/nix-agent-sandbox/operations/maintenance/#worktree-の削除)を参照してください。`nas worktree clean` は使用中の worktree も削除できるため、先にエージェントの終了を確認してください。

## 関連ページ

- [設定の基本](/nix-agent-sandbox/getting-started/configuration/) — プロジェクト設定の信頼確認
- [セッション・通知](/nix-agent-sandbox/features/sessions/) — ターミナルの切り離しと再接続
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `WorktreeConfig` の全定義
