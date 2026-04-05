import { assertEquals, assertRejects } from "@std/assert";
import $ from "dax";
import { resolveBase } from "./worktree.ts";

/** 一時 git リポジトリを作成してコールバックを実行し、後片付けする */
async function withTempRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-test-" });
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

Deno.test("resolveBase: non-HEAD value is returned as-is", async () => {
  await withTempRepo(async (repo) => {
    assertEquals(await resolveBase(repo, "origin/main"), "origin/main");
    assertEquals(await resolveBase(repo, "develop"), "develop");
  });
});

Deno.test("resolveBase: HEAD resolves to current branch name", async () => {
  await withTempRepo(async (repo) => {
    // デフォルトブランチ名を取得
    const defaultBranch =
      (await $`git -C ${repo} symbolic-ref --short HEAD`.text()).trim();
    assertEquals(await resolveBase(repo, "HEAD"), defaultBranch);

    // 別ブランチに切り替えてテスト
    await $`git -C ${repo} checkout -b feature-test`.quiet("both");
    assertEquals(await resolveBase(repo, "HEAD"), "feature-test");
  });
});

Deno.test("resolveBase: HEAD in detached state throws error", async () => {
  await withTempRepo(async (repo) => {
    const sha = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    await $`git -C ${repo} checkout ${sha}`.quiet("both");

    await assertRejects(
      () => resolveBase(repo, "HEAD"),
      Error,
      "detached HEAD state",
    );
  });
});
