---
title: Worktree
description: agent の作業を専用 Git worktree と branch に分ける
---

## どんな機能？

Worktree を有効にすると、nas は repository の `.nas/worktrees/nas-<timestamp>/` に作業用 worktree を作り、`nas/<timestamp>` branch を checkout して agent をそこで起動します。終了時には作業 tree と branch をどう扱うか選べます。

## いつ使う？

別の agent や自分の作業 tree を汚さず、ひとつの依頼を branch として分けたいときに使います。Git repository ではない directory や、直接現在の checkout を使いたい run には向きません。

## 主要な設定項目

| 設定 / option | 既定 | 用途 |
| --- | --- | --- |
| `worktree.base` | — | 新しい branch の基準 ref。`HEAD` は現在の HEAD。 |
| `worktree.onCreate` | — | worktree 作成後、その directory で `bash -c` 実行する準備コマンド。 |
| `-b`, `--worktree <branch>` | なし | 一回だけ worktree を有効にし、基準 branch を指定する。`@` も `HEAD` として扱う。 |
| `--no-worktree` | なし | profile の worktree 設定をその run だけ無効にする。 |

## 最小の設定例

profile に常時設定する場合は、基準 branch と作成直後の準備を指定します。

```pkl
worktree = new WorktreeConfig {
  base = "main"
  onCreate = "bun install"
}
```

一回だけ使う場合と、残ったものを管理する場合は別の interface です。

```sh
$ nas -b main claude
[nas] Creating worktree: .../.nas/worktrees/nas-... (branch: nas/...)
...
$ nas worktree list
$ nas worktree clean --delete-branch
```

`-b` / `--worktree` は main command の option なので profile 名より前に置きます。`nas worktree` は過去の nas-managed worktree を list / clean する管理 subcommand であり、new session を作る command ではありません。`clean` は branch を既定では残し、`--delete-branch` を付けると worktree に紐づく branch と orphan の `nas/*` branch も削除対象にします。

## 注意点・セキュリティへの影響

作成時、既存の nas-managed worktree があれば reuse するか新規作成するかを選べます。終了時は worktree を keep または delete できます。dirty worktree を delete する場合は stash、stash せず削除、keep を選び、unique commit がある branch は delete、base への cherry-pick、rename-and-keep を選びます。cherry-pick に失敗した branch は手動解決のため残ります。

`onCreate` は worktree directory で host 側の `bash -c` として実行されます。profile 設定を信頼することと同じ境界なので、agent が書き換えられる文字列をここへ入れないでください。

設定を信頼する意味と bypass の扱いは、[repository を信頼する境界](/nix-agent-sandbox/security/model/#repository-trust)を確認してください。

## 関連ページ

- [設定の基本](/nix-agent-sandbox/getting-started/configuration/) — project config を確認して信頼する手順
- [セッション・通知](/nix-agent-sandbox/features/sessions/) — 長時間の作業を detach / attach する
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `WorktreeConfig` の全定義
