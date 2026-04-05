import { assertEquals } from "@std/assert";
import $ from "dax";
import {
  cleanNasWorktrees,
  listNasWorktrees,
  listOrphanNasBranches,
} from "./worktree.ts";

/** 一時 git リポジトリを作成してコールバックを実行し、後片付けする */
async function withTempRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "wt-test-" });
  try {
    await $`git init ${tmpDir}`.quiet("both");
    await $`git -C ${tmpDir} config user.name nas-test`.quiet("both");
    await $`git -C ${tmpDir} config user.email nas-test@example.com`.quiet(
      "both",
    );
    await $`git -C ${tmpDir} config commit.gpgsign false`.quiet("both");
    await $`git -C ${tmpDir} commit --allow-empty -m "init"`.quiet("both");
    await fn(tmpDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/** テスト用の nas worktree を作成するヘルパー */
async function createTestWorktree(
  repoRoot: string,
  profileName: string,
  suffix: string,
): Promise<{ worktreePath: string; branchName: string }> {
  const worktreeName = `nas-${profileName}-${suffix}`;
  const branchName = `nas/${profileName}/${suffix}`;
  const { join } = await import("@std/path");
  const worktreePath = join(repoRoot, ".git", "nas-worktrees", worktreeName);
  await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} HEAD`
    .quiet("both");
  return { worktreePath, branchName };
}

// --- listNasWorktrees ---

Deno.test("listNasWorktrees: returns empty list for fresh repo", async () => {
  await withTempRepo(async (repo) => {
    const entries = await listNasWorktrees(repo);
    assertEquals(entries.length, 0);
  });
});

Deno.test("listNasWorktrees: finds nas worktrees", async () => {
  await withTempRepo(async (repo) => {
    await createTestWorktree(repo, "myprofile", "2026-01-01T00-00-00");
    await createTestWorktree(repo, "myprofile", "2026-01-02T00-00-00");

    const entries = await listNasWorktrees(repo);
    assertEquals(entries.length, 2);
    assertEquals(
      entries.every((e) => e.path.includes("nas-myprofile-")),
      true,
    );
    assertEquals(
      entries.every((e) => e.branch.includes("nas/myprofile/")),
      true,
    );
  });
});

Deno.test("listNasWorktrees: ignores non-nas worktrees", async () => {
  await withTempRepo(async (repo) => {
    // nas worktree
    await createTestWorktree(repo, "test", "2026-01-01T00-00-00");
    // non-nas worktree
    const { join } = await import("@std/path");
    const otherPath = join(repo, ".git", "other-worktree");
    await $`git -C ${repo} worktree add -b other-branch ${otherPath} HEAD`
      .quiet("both");

    const entries = await listNasWorktrees(repo);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].path.includes("nas-test-"), true);
  });
});

// --- listOrphanNasBranches ---

Deno.test("listOrphanNasBranches: returns empty when no orphans", async () => {
  await withTempRepo(async (repo) => {
    // worktree に紐づいたブランチのみ
    await createTestWorktree(repo, "test", "2026-01-01T00-00-00");

    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 0);
  });
});

Deno.test("listOrphanNasBranches: finds branches without worktrees", async () => {
  await withTempRepo(async (repo) => {
    // worktree を作って削除（ブランチは残る）
    const { worktreePath, branchName } = await createTestWorktree(
      repo,
      "test",
      "2026-01-01T00-00-00",
    );
    await $`git -C ${repo} worktree remove --force ${worktreePath}`.quiet(
      "both",
    );

    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 1);
    assertEquals(orphans[0], branchName);
  });
});

// --- cleanNasWorktrees ---

Deno.test("cleanNasWorktrees: removes all nas worktrees with force", async () => {
  await withTempRepo(async (repo) => {
    await createTestWorktree(repo, "prof1", "2026-01-01T00-00-00");
    await createTestWorktree(repo, "prof2", "2026-01-02T00-00-00");

    const result = await cleanNasWorktrees(repo, { force: true });
    assertEquals(result.worktrees, 2);

    const remaining = await listNasWorktrees(repo);
    assertEquals(remaining.length, 0);
  });
});

Deno.test("cleanNasWorktrees: returns zero counts for empty repo", async () => {
  await withTempRepo(async (repo) => {
    const result = await cleanNasWorktrees(repo, { force: true });
    assertEquals(result.worktrees, 0);
    assertEquals(result.orphanBranches, 0);
  });
});

Deno.test("cleanNasWorktrees: with deleteBranch removes orphan branches too", async () => {
  await withTempRepo(async (repo) => {
    // worktree 付きブランチ
    await createTestWorktree(repo, "active", "2026-01-01T00-00-00");

    // orphan ブランチ（worktree を作って消す）
    const { worktreePath } = await createTestWorktree(
      repo,
      "orphan",
      "2026-01-02T00-00-00",
    );
    await $`git -C ${repo} worktree remove --force ${worktreePath}`.quiet(
      "both",
    );

    const result = await cleanNasWorktrees(repo, {
      force: true,
      deleteBranch: true,
    });
    assertEquals(result.worktrees, 1); // active のみ（orphan の worktree は既に削除済み）
    assertEquals(result.orphanBranches, 1);

    const remaining = await listNasWorktrees(repo);
    assertEquals(remaining.length, 0);

    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 0);
  });
});
