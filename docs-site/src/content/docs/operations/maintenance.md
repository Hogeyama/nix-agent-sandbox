---
title: Docker イメージを再ビルドする
description: nas image、過去の Worktree、未使用 sidecar を安全に整理する
---

## Docker イメージを再ビルドする

nas image を作り直すには `nas rebuild` を使います。image があれば最初に通常の Docker
image removal を試み、成功後に build pipeline を走らせます。

```sh
nas rebuild
nas rebuild --force
```

`--force`（`-f`）は `docker rmi --force` を使うので、image を参照中の container がある
場合にも削除できます。実行中の session を止める操作ではありませんが、その session が
使う image を強制削除する前に終了させるのが安全です。

## 過去の Worktree を整理する

`nas worktree` は ownership metadata を持ちません。現在の selector は git worktree の path の
basename が `nas-` で始まるかだけです。したがって nas が作ったものだけでなく、ユーザーが
作った `nas-*` basename の worktree も対象になります。

```sh
nas worktree list
nas worktree list --format json
nas worktree clean
nas worktree clean -f
nas worktree clean -f -B
```

`list` は既定 subcommand で、path、branch、base、HEAD を表示します。`clean` は確認を
求めて matching な `nas-*` worktree を force remove し、`-f` / `--force` はその確認を
省略します。`-B` / `--delete-branch` を併用すると、削除した worktree の orphan branch も
削除します。さらに cleanup の開始時点で orphan だった**すべての** `nas/*` branch も削除
するため、この invocation で worktree を削除したかどうかには依存しません。

> **警告:** `nas worktree clean` に active-session guard はありません。実行中または detach
> 済み session が使う worktree も matching なら削除できます。detach は terminal を外すだけで
> agent を停止しません。session が実際に終了したことを確認してから実行してください。
> `nas session list` は multiplex を有効にした dtach session だけを一覧にするため、そこに
> 表示がないことは non-multiplexed session の停止証明になりません。該当する agent process
> または container も手動で確認し、`nas worktree list` の対象を確認してから削除します。

## 未使用 sidecar を整理する

```sh
nas container list
nas container list --format json
nas container clean
```

`list` は nas 管理 container の名前、kind、running 状態、開始時刻を表示します。
`clean` は session から使用されていない nas sidecar container を削除し、空になった nas
network と session 用の一時 volume も回収します。実行中の agent container や、その agent に接続中の
sidecar は対象外です。public Docker Hub pull を session 間で再利用する永続 volume
`nas-registry-cache` は、unused sidecar がなくても意図的に削除しません。この unused-sidecar
protection は `worktree clean` には適用されません。
削除対象がなければ `No unused nas sidecars found.` と表示されます。

## 関連ページ

- [Worktree](/nix-agent-sandbox/features/worktree/)
- [Docker in Docker](/nix-agent-sandbox/features/docker/)
- [セッション・通知](/nix-agent-sandbox/features/sessions/)
