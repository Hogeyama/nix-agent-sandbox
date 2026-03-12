/**
 * E2E tests: WorktreeStage
 *
 * WorktreeStage の execute を実際の git リポジトリで検証する。
 * teardown はインタラクティブプロンプトを必要とするため、execute のみテスト。
 */

import { assertEquals, assertRejects } from "@std/assert";
import $ from "dax";
import * as path from "@std/path";
import type { Config, Profile } from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import {
  cleanNasWorktrees,
  listNasWorktrees,
  listOrphanNasBranches,
  resolveBase,
  WorktreeStage,
} from "../src/stages/worktree.ts";

/** 一時 git リポジトリを作成してコールバックを実行し、後片付けする */
async function withTempRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "wt-e2e-" });
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
  const worktreePath = path.join(
    repoRoot,
    ".git",
    "nas-worktrees",
    worktreeName,
  );
  await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} HEAD`
    .quiet("both");
  return { worktreePath, branchName };
}

function createTestProfile(base: string): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    worktree: { base, onCreate: "" },
    nix: { enable: "auto", mountSocket: true, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    extraMounts: [],
    env: [],
  };
}

function createTestConfig(profile: Profile): Config {
  return {
    default: "test",
    profiles: { test: profile },
  };
}

// --- resolveBase ---

Deno.test("resolveBase: non-HEAD values returned as-is", async () => {
  await withTempRepo(async (repo) => {
    assertEquals(await resolveBase(repo, "origin/main"), "origin/main");
    assertEquals(await resolveBase(repo, "develop"), "develop");
    assertEquals(await resolveBase(repo, "refs/tags/v1.0"), "refs/tags/v1.0");
  });
});

Deno.test("resolveBase: HEAD resolves to current branch name", async () => {
  await withTempRepo(async (repo) => {
    // デフォルトブランチ上で HEAD を解決
    const branch = (
      await $`git -C ${repo} symbolic-ref --short HEAD`.text()
    ).trim();
    const resolved = await resolveBase(repo, "HEAD");
    assertEquals(resolved, branch);
  });
});

Deno.test("resolveBase: HEAD on named branch", async () => {
  await withTempRepo(async (repo) => {
    await $`git -C ${repo} checkout -b feature-branch`.quiet("both");
    const resolved = await resolveBase(repo, "HEAD");
    assertEquals(resolved, "feature-branch");
  });
});

Deno.test("resolveBase: HEAD throws in detached HEAD state", async () => {
  await withTempRepo(async (repo) => {
    const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    await $`git -C ${repo} checkout --detach ${head}`.quiet("both");
    await assertRejects(
      () => resolveBase(repo, "HEAD"),
      Error,
      "detached HEAD",
    );
  });
});

// --- listNasWorktrees: 追加テスト ---

Deno.test("listNasWorktrees: returns entries with correct structure", async () => {
  await withTempRepo(async (repo) => {
    const { worktreePath, branchName } = await createTestWorktree(
      repo,
      "prof",
      "2026-03-01T00-00-00",
    );

    const entries = await listNasWorktrees(repo);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].path, worktreePath);
    assertEquals(entries[0].branch, `refs/heads/${branchName}`);
    assertEquals(entries[0].head.length, 40); // SHA-1 hex
  });
});

Deno.test("listNasWorktrees: multiple profiles sorted correctly", async () => {
  await withTempRepo(async (repo) => {
    await createTestWorktree(repo, "alpha", "2026-01-01T00-00-00");
    await createTestWorktree(repo, "beta", "2026-01-02T00-00-00");
    await createTestWorktree(repo, "alpha", "2026-01-03T00-00-00");

    const entries = await listNasWorktrees(repo);
    assertEquals(entries.length, 3);
    // alpha が 2 つ、beta が 1 つ
    const alphaEntries = entries.filter((e) =>
      path.basename(e.path).startsWith("nas-alpha-")
    );
    const betaEntries = entries.filter((e) =>
      path.basename(e.path).startsWith("nas-beta-")
    );
    assertEquals(alphaEntries.length, 2);
    assertEquals(betaEntries.length, 1);
  });
});

Deno.test("listNasWorktrees: does not include main worktree", async () => {
  await withTempRepo(async (repo) => {
    const entries = await listNasWorktrees(repo);
    // メインの worktree は nas- プレフィックスがないので含まれない
    assertEquals(entries.length, 0);
  });
});

// --- listOrphanNasBranches: 追加テスト ---

Deno.test("listOrphanNasBranches: empty repo returns empty", async () => {
  await withTempRepo(async (repo) => {
    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 0);
  });
});

Deno.test("listOrphanNasBranches: active worktree branch is not orphan", async () => {
  await withTempRepo(async (repo) => {
    await createTestWorktree(repo, "active", "2026-01-01T00-00-00");
    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 0);
  });
});

Deno.test("listOrphanNasBranches: multiple orphans found", async () => {
  await withTempRepo(async (repo) => {
    // 2つの worktree を作って両方削除
    const wt1 = await createTestWorktree(repo, "test", "2026-01-01T00-00-00");
    const wt2 = await createTestWorktree(repo, "test", "2026-01-02T00-00-00");
    await $`git -C ${repo} worktree remove --force ${wt1.worktreePath}`.quiet(
      "both",
    );
    await $`git -C ${repo} worktree remove --force ${wt2.worktreePath}`.quiet(
      "both",
    );

    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 2);
    assertEquals(
      orphans.some((b) => b === "nas/test/2026-01-01T00-00-00"),
      true,
    );
    assertEquals(
      orphans.some((b) => b === "nas/test/2026-01-02T00-00-00"),
      true,
    );
  });
});

Deno.test("listOrphanNasBranches: mix of active and orphan", async () => {
  await withTempRepo(async (repo) => {
    // active worktree
    await createTestWorktree(repo, "active", "2026-01-01T00-00-00");
    // orphan: create and remove worktree
    const orphan = await createTestWorktree(
      repo,
      "orphan",
      "2026-01-02T00-00-00",
    );
    await $`git -C ${repo} worktree remove --force ${orphan.worktreePath}`
      .quiet("both");

    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 1);
    assertEquals(orphans[0], "nas/orphan/2026-01-02T00-00-00");
  });
});

// --- cleanNasWorktrees: 追加テスト ---

Deno.test("cleanNasWorktrees: force removes multiple worktrees", async () => {
  await withTempRepo(async (repo) => {
    await createTestWorktree(repo, "a", "2026-01-01T00-00-00");
    await createTestWorktree(repo, "b", "2026-01-02T00-00-00");
    await createTestWorktree(repo, "c", "2026-01-03T00-00-00");

    const result = await cleanNasWorktrees(repo, { force: true });
    assertEquals(result.worktrees, 3);

    const remaining = await listNasWorktrees(repo);
    assertEquals(remaining.length, 0);
  });
});

Deno.test("cleanNasWorktrees: with deleteBranch also removes worktree branches", async () => {
  await withTempRepo(async (repo) => {
    await createTestWorktree(repo, "prof", "2026-01-01T00-00-00");

    const result = await cleanNasWorktrees(repo, {
      force: true,
      deleteBranch: true,
    });
    assertEquals(result.worktrees, 1);

    // ブランチも削除されていること
    const branches = (
      await $`git -C ${repo} branch --list nas/*`.text()
    ).trim();
    assertEquals(branches, "");
  });
});

Deno.test("cleanNasWorktrees: with deleteBranch removes orphans too", async () => {
  await withTempRepo(async (repo) => {
    // orphan を作る
    const wt = await createTestWorktree(repo, "dead", "2026-01-01T00-00-00");
    await $`git -C ${repo} worktree remove --force ${wt.worktreePath}`.quiet(
      "both",
    );

    const result = await cleanNasWorktrees(repo, {
      force: true,
      deleteBranch: true,
    });
    assertEquals(result.orphanBranches, 1);

    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 0);
  });
});

Deno.test("cleanNasWorktrees: does not touch non-nas worktrees", async () => {
  await withTempRepo(async (repo) => {
    // nas worktree
    await createTestWorktree(repo, "test", "2026-01-01T00-00-00");
    // non-nas worktree
    const otherPath = path.join(repo, ".git", "other-worktree");
    await $`git -C ${repo} worktree add -b other-branch ${otherPath} HEAD`
      .quiet("both");

    await cleanNasWorktrees(repo, { force: true });

    // non-nas worktree はまだ存在する
    const output = await $`git -C ${repo} worktree list --porcelain`.text();
    assertEquals(output.includes(otherPath), true);
    assertEquals(output.includes("other-branch"), true);

    // cleanup
    await $`git -C ${repo} worktree remove --force ${otherPath}`.quiet("both");
  });
});

// --- worktree 名の形式 ---

Deno.test("worktree naming: worktree path is under .git/nas-worktrees/", async () => {
  await withTempRepo(async (repo) => {
    const { worktreePath } = await createTestWorktree(
      repo,
      "myprof",
      "2026-06-15T12-30-45",
    );
    assertEquals(
      worktreePath,
      path.join(
        repo,
        ".git",
        "nas-worktrees",
        "nas-myprof-2026-06-15T12-30-45",
      ),
    );
  });
});

Deno.test("worktree naming: branch follows nas/<profile>/<timestamp> pattern", async () => {
  await withTempRepo(async (repo) => {
    const { branchName } = await createTestWorktree(
      repo,
      "myprof",
      "2026-06-15T12-30-45",
    );
    assertEquals(branchName, "nas/myprof/2026-06-15T12-30-45");
  });
});

// --- 複数の worktree ライフサイクル ---

Deno.test("E2E worktree lifecycle: create, list, clean", async () => {
  await withTempRepo(async (repo) => {
    // 1. 空のリスト
    assertEquals((await listNasWorktrees(repo)).length, 0);

    // 2. worktree 作成
    await createTestWorktree(repo, "lifecycle", "2026-01-01T00-00-00");
    await createTestWorktree(repo, "lifecycle", "2026-01-02T00-00-00");

    // 3. リストに2つ表示
    const entries = await listNasWorktrees(repo);
    assertEquals(entries.length, 2);

    // 4. 1つ削除
    await $`git -C ${repo} worktree remove --force ${entries[0].path}`.quiet(
      "both",
    );
    assertEquals((await listNasWorktrees(repo)).length, 1);

    // 5. orphan ブランチが1つ
    const orphans = await listOrphanNasBranches(repo);
    assertEquals(orphans.length, 1);

    // 6. 全削除
    const result = await cleanNasWorktrees(repo, {
      force: true,
      deleteBranch: true,
    });
    assertEquals(result.worktrees, 1);
    assertEquals(result.orphanBranches, 1);

    // 7. 完全にクリーン
    assertEquals((await listNasWorktrees(repo)).length, 0);
    assertEquals((await listOrphanNasBranches(repo)).length, 0);
  });
});

// --- worktree 内でのコミット ---

Deno.test("E2E worktree: commits in worktree are visible", async () => {
  await withTempRepo(async (repo) => {
    const { worktreePath, branchName } = await createTestWorktree(
      repo,
      "commit-test",
      "2026-01-01T00-00-00",
    );

    // worktree 内でファイルを作成してコミット
    await Deno.writeTextFile(path.join(worktreePath, "test.txt"), "hello");
    await $`git -C ${worktreePath} add test.txt`.quiet("both");
    await $`git -C ${worktreePath} commit -m "add test.txt"`.quiet("both");

    // メインリポジトリからそのブランチのログが見える
    const log = (
      await $`git -C ${repo} log ${branchName} --oneline -1`.text()
    ).trim();
    assertEquals(log.includes("add test.txt"), true);

    // cleanup
    await $`git -C ${repo} worktree remove --force ${worktreePath}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

// --- worktree ベースブランチからの分岐 ---

Deno.test("E2E worktree: branches from correct base", async () => {
  await withTempRepo(async (repo) => {
    // base にコミットを追加
    await Deno.writeTextFile(path.join(repo, "base.txt"), "base content");
    await $`git -C ${repo} add base.txt`.quiet("both");
    await $`git -C ${repo} commit -m "base commit"`.quiet("both");
    const baseHead = (
      await $`git -C ${repo} rev-parse HEAD`.text()
    ).trim();

    // worktree を作成
    const { worktreePath, branchName } = await createTestWorktree(
      repo,
      "base-test",
      "2026-01-01T00-00-00",
    );

    // worktree の初期 HEAD がベースと同じ
    const wtHead = (
      await $`git -C ${worktreePath} rev-parse HEAD`.text()
    ).trim();
    assertEquals(wtHead, baseHead);

    // base.txt が worktree にも存在する
    const content = await Deno.readTextFile(
      path.join(worktreePath, "base.txt"),
    );
    assertEquals(content, "base content");

    // cleanup
    await $`git -C ${repo} worktree remove --force ${worktreePath}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

Deno.test("E2E worktree: inherits dirty tracked and untracked changes from checked out base branch", async () => {
  await withTempRepo(async (repo) => {
    await Deno.writeTextFile(path.join(repo, "tracked.txt"), "base\n");
    await Deno.writeTextFile(path.join(repo, "staged.txt"), "base\n");
    await $`git -C ${repo} add tracked.txt staged.txt`.quiet("both");
    await $`git -C ${repo} commit -m "add base files"`.quiet("both");

    await Deno.writeTextFile(
      path.join(repo, "tracked.txt"),
      "base\nunstaged\n",
    );
    await Deno.writeTextFile(path.join(repo, "staged.txt"), "base\nstaged\n");
    await $`git -C ${repo} add staged.txt`.quiet("both");
    await Deno.writeTextFile(path.join(repo, "untracked.txt"), "untracked\n");

    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = new WorktreeStage();
    const ctx = createContext(config, profile, "test", repo);
    const next = await stage.execute(ctx);

    assertEquals(
      await Deno.readTextFile(path.join(next.workDir, "tracked.txt")),
      "base\nunstaged\n",
    );
    assertEquals(
      await Deno.readTextFile(path.join(next.workDir, "staged.txt")),
      "base\nstaged\n",
    );
    assertEquals(
      await Deno.readTextFile(path.join(next.workDir, "untracked.txt")),
      "untracked\n",
    );

    const status = (
      await $`git -C ${next.workDir} status --short`.text()
    ).trim().split("\n").filter(Boolean);
    assertEquals(status.includes(" M tracked.txt"), true);
    assertEquals(status.includes("M  staged.txt"), true);
    assertEquals(status.includes("?? untracked.txt"), true);

    const branchName = (await $`git -C ${next.workDir} branch --show-current`
      .text()).trim();
    await $`git -C ${repo} worktree remove --force ${next.workDir}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

Deno.test("E2E worktree: does not inherit when base branch worktree is clean", async () => {
  await withTempRepo(async (repo) => {
    await Deno.writeTextFile(path.join(repo, "tracked.txt"), "base\n");
    await $`git -C ${repo} add tracked.txt`.quiet("both");
    await $`git -C ${repo} commit -m "add tracked file"`.quiet("both");

    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = new WorktreeStage();
    const ctx = createContext(config, profile, "test", repo);
    const next = await stage.execute(ctx);

    const status = (await $`git -C ${next.workDir} status --short`.text())
      .trim();
    assertEquals(status, "");
    assertEquals(
      await Deno.readTextFile(path.join(next.workDir, "tracked.txt")),
      "base\n",
    );

    const branchName = (await $`git -C ${next.workDir} branch --show-current`
      .text()).trim();
    await $`git -C ${repo} worktree remove --force ${next.workDir}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

// --- 大量の worktree ---

Deno.test("E2E worktree: handles many worktrees", async () => {
  await withTempRepo(async (repo) => {
    const count = 10;
    for (let i = 0; i < count; i++) {
      const suffix = `2026-01-${String(i + 1).padStart(2, "0")}T00-00-00`;
      await createTestWorktree(repo, "bulk", suffix);
    }

    const entries = await listNasWorktrees(repo);
    assertEquals(entries.length, count);

    const result = await cleanNasWorktrees(repo, {
      force: true,
      deleteBranch: true,
    });
    assertEquals(result.worktrees, count);

    assertEquals((await listNasWorktrees(repo)).length, 0);
    assertEquals((await listOrphanNasBranches(repo)).length, 0);
  });
});
