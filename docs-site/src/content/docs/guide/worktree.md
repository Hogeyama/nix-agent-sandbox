---
title: Worktree
description: ベースブランチから git worktree を自動作成する
sidebar:
  order: 8
---

`nas --worktree <base-branch> <profile>` を実行すると、ベースブランチから `nas/{profile}/{timestamp}` ブランチ付きの git worktree が自動作成されます。
エージェント終了後は、stash、コミットの cherry-pick、ブランチを残して手動で取り込む、などの方法で成果物を回収できます。

溜まった worktree の掃除は[運用コマンド → Worktree の掃除](/nix-agent-sandbox/operations/commands/#worktree-の掃除)を参照してください。

<details>
<summary>実行例</summary>

```
$ nas --worktree HEAD claude
[nas] Resolved HEAD to current branch: main
> git -C '/home/hogeyama/repo/nix-agent-sandbox' worktree add -b 'nas/claude/2026-03-17T14-01-57-692Z' '/home/hogeyama/repo/nix-agent-sandbox/.nas/worktrees/nas-claude-2026-03-17T14-01-57-692Z' main
Preparing worktree (new branch 'nas/claude/2026-03-17T14-01-57-692Z')
HEAD is now at d79dcfc

  ... (エージェントが起動し、作業を行う) ...

[nas] Worktree HEAD: 48be913994c4f92ac256d60215b72f0ab9aa1b15
[nas] ⚠ Worktree has uncommitted changes.
[nas] What to do with the worktree?
  1. Delete
  2. Keep
[nas] Choose [1/2]: 1
[nas] Worktree has uncommitted changes.
[nas] How should we handle them before deleting it?
  1. Stash and delete
  2. Delete without stashing
  3. Keep
[nas] Choose [1/2/3]: 1
> git -C '/home/hogeyama/repo/nix-agent-sandbox/.nas/worktrees/nas-claude-2026-03-17T14-01-57-692Z' stash push --include-untracked -m 'nas teardown nas-claude-2026-03-17T14-01-57-692Z 2026-03-17T14:05:33.117Z'
Saved working directory and index state On nas/claude/2026-03-17T14-01-57-692Z: nas teardown nas-claude-2026-03-17T14-01-57-692Z 2026-03-17T14:05:33.117Z
[nas] Stashed worktree changes: nas teardown nas-claude-2026-03-17T14-01-57-692Z 2026-03-17T14:05:33.117Z
[nas] What to do with the branch?
  1. Delete
  2. Cherry-pick to base branch
  3. Rename and keep
[nas] Choose [1/2/3]: 2
[nas] No commits to cherry-pick.
[nas] Removing worktree: /home/hogeyama/repo/nix-agent-sandbox/.nas/worktrees/nas-claude-2026-03-17T14-01-57-692Z
Deleted branch nas/claude/2026-03-17T14-01-57-692Z (was 48be913).
[nas] Deleted branch: nas/claude/2026-03-17T14-01-57-692Z
```

</details>
