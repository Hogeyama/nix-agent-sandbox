import { assertEquals, assertStringIncludes } from "@std/assert";
import $ from "dax";
import * as path from "@std/path";
import { DEFAULT_NETWORK_CONFIG } from "../src/config/types.ts";
import type { Config, Profile } from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import { WorktreeStage } from "../src/stages/worktree.ts";

const testProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  worktree: { base: "HEAD", onCreate: "" },
  nix: { enable: "auto", mountSocket: true, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  extraMounts: [],
  env: [],
};

const testConfig: Config = {
  default: "test",
  profiles: { test: testProfile },
};

async function withTempRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "wt-teardown-" });
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

async function withMockedPrompts(
  answers: string[],
  fn: () => Promise<void>,
): Promise<void> {
  const originalPrompt = globalThis.prompt;
  let index = 0;

  Object.defineProperty(globalThis, "prompt", {
    configurable: true,
    writable: true,
    value: () => {
      if (index >= answers.length) {
        throw new Error("Unexpected prompt call");
      }
      return answers[index++];
    },
  });

  try {
    await fn();
    assertEquals(index, answers.length);
  } finally {
    Object.defineProperty(globalThis, "prompt", {
      configurable: true,
      writable: true,
      value: originalPrompt,
    });
  }
}

Deno.test("WorktreeStage teardown stashes dirty changes before deleting", async () => {
  await withTempRepo(async (repoRoot) => {
    await withMockedPrompts(["1", "1", "1"], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);
      const worktreePath = next.workDir;

      await Deno.writeTextFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown(next);

      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertEquals(worktreeList.includes(worktreePath), false);

      const branchList = (await $`git -C ${repoRoot} branch --list nas/test/*`
        .text()).trim();
      assertEquals(branchList, "");

      const stashList = (await $`git -C ${repoRoot} stash list`.text()).trim();
      assertStringIncludes(stashList, "nas teardown");

      const stashedFiles =
        await $`git -C ${repoRoot} stash show --name-only --include-untracked ${"stash@{0}"}`
          .text();
      assertStringIncludes(stashedFiles, "draft.txt");
    });
  });
});

Deno.test("WorktreeStage teardown can keep a dirty worktree from the stash prompt", async () => {
  await withTempRepo(async (repoRoot) => {
    await withMockedPrompts(["1", "3"], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);
      const worktreePath = next.workDir;
      const branchName = (await $`git -C ${worktreePath} branch --show-current`
        .text()).trim();

      await Deno.writeTextFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown(next);

      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertStringIncludes(worktreeList, worktreePath);

      const branchList =
        (await $`git -C ${repoRoot} branch --list ${branchName}`
          .text()).trim();
      assertStringIncludes(branchList, branchName);

      const stashList = (await $`git -C ${repoRoot} stash list`.text()).trim();
      assertEquals(stashList, "");

      await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet(
        "both",
      );
      await $`git -C ${repoRoot} branch -D ${branchName}`.quiet("both");
    });
  });
});

// --- promptWorktreeAction: "keep" ---

Deno.test("WorktreeStage teardown keeps worktree when user chooses keep", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "2" (keep)
    await withMockedPrompts(["2"], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);
      const worktreePath = next.workDir;
      const branchName =
        (await $`git -C ${worktreePath} branch --show-current`.text()).trim();

      await stage.teardown(next);

      // worktree が残っている
      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertStringIncludes(worktreeList, worktreePath);

      // cleanup
      await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet(
        "both",
      );
      await $`git -C ${repoRoot} branch -D ${branchName}`.quiet("both");
    });
  });
});

// --- clean worktree delete (no dirty prompt) ---

Deno.test("WorktreeStage teardown deletes clean worktree and branch", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "1" (delete)
    await withMockedPrompts(["1", "1"], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);
      const worktreePath = next.workDir;

      // worktree は clean (dirty ファイルなし)
      await stage.teardown(next);

      // worktree が削除されている
      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertEquals(worktreeList.includes(worktreePath), false);

      // ブランチも削除されている
      const branchList =
        (await $`git -C ${repoRoot} branch --list nas/test/*`.text()).trim();
      assertEquals(branchList, "");
    });
  });
});

// --- dirty worktree: delete without stashing ---

Deno.test("WorktreeStage teardown deletes dirty worktree without stashing", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → "2" (delete without stash)
    // promptBranchAction → "1" (delete)
    await withMockedPrompts(["1", "2", "1"], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);
      const worktreePath = next.workDir;

      await Deno.writeTextFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown(next);

      // worktree が削除されている
      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertEquals(worktreeList.includes(worktreePath), false);

      // stash に何もない
      const stashList = (await $`git -C ${repoRoot} stash list`.text()).trim();
      assertEquals(stashList, "");
    });
  });
});

// --- branch rename ---

Deno.test("WorktreeStage teardown renames branch and keeps it", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "3" (rename)
    // prompt for new name → "my-saved-branch"
    await withMockedPrompts(["1", "3", "my-saved-branch"], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);
      const worktreePath = next.workDir;

      await stage.teardown(next);

      // worktree は削除されている
      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertEquals(worktreeList.includes(worktreePath), false);

      // 元のブランチは消え、リネーム先が存在
      const oldBranch =
        (await $`git -C ${repoRoot} branch --list nas/test/*`.text()).trim();
      assertEquals(oldBranch, "");

      const newBranch =
        (await $`git -C ${repoRoot} branch --list my-saved-branch`.text())
          .trim();
      assertStringIncludes(newBranch, "my-saved-branch");

      // cleanup
      await $`git -C ${repoRoot} branch -D my-saved-branch`.quiet("both");
    });
  });
});

// --- branch rename with empty name (keeps original) ---

Deno.test("WorktreeStage teardown rename with empty name keeps original branch name", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "3" (rename)
    // prompt for new name → "" (empty)
    await withMockedPrompts(["1", "3", ""], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);

      await stage.teardown(next);

      // worktree は削除されているがブランチ名はそのまま残る
      // (rename がスキップされ、worktree remove 後もブランチ削除されない)
    });
  });
});

// --- cherry-pick to base ---

Deno.test("WorktreeStage teardown cherry-picks commits to base branch", async () => {
  await withTempRepo(async (repoRoot) => {
    // base ブランチにファイルを追加
    await Deno.writeTextFile(path.join(repoRoot, "base.txt"), "base\n");
    await $`git -C ${repoRoot} add base.txt`.quiet("both");
    await $`git -C ${repoRoot} commit -m "base file"`.quiet("both");

    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "2" (cherry-pick)
    await withMockedPrompts(["1", "2"], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);
      const worktreePath = next.workDir;

      // worktree 内でコミットを作成
      await Deno.writeTextFile(
        path.join(worktreePath, "feature.txt"),
        "feature\n",
      );
      await $`git -C ${worktreePath} add feature.txt`.quiet("both");
      await $`git -C ${worktreePath} commit -m "add feature"`.quiet("both");

      await stage.teardown(next);

      // base ブランチに cherry-pick されたコミットが入っている
      const baseBranch =
        (await $`git -C ${repoRoot} symbolic-ref --short HEAD`.text()).trim();
      const log =
        (await $`git -C ${repoRoot} log ${baseBranch} --oneline -5`.text())
          .trim();
      assertStringIncludes(log, "add feature");

      // worktree は削除されている
      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertEquals(worktreeList.includes(worktreePath), false);
    });
  });
});

// --- cherry-pick with no commits ---

Deno.test("WorktreeStage teardown cherry-pick with no new commits succeeds", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "2" (cherry-pick)
    await withMockedPrompts(["1", "2"], async () => {
      const stage = new WorktreeStage();
      const ctx = createContext(testConfig, testProfile, "test", repoRoot);
      const next = await stage.execute(ctx);

      // コミットせずに teardown
      await stage.teardown(next);

      // エラーなく完了
      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertEquals(worktreeList.includes(next.workDir), false);
    });
  });
});

// --- teardown without execute (no worktree) ---

Deno.test("WorktreeStage teardown without execute is a no-op", async () => {
  const stage = new WorktreeStage();
  const profile: Profile = {
    ...testProfile,
    worktree: undefined,
  };
  const config: Config = { default: "test", profiles: { test: profile } };
  const ctx = createContext(config, profile, "test", "/tmp/nonexistent");
  // teardown should not throw
  await stage.teardown(ctx);
});

// --- execute skips when worktree not configured ---

Deno.test("WorktreeStage execute skips when worktree is not configured", async () => {
  const stage = new WorktreeStage();
  const profile: Profile = {
    ...testProfile,
    worktree: undefined,
  };
  const config: Config = { default: "test", profiles: { test: profile } };
  const ctx = createContext(config, profile, "test", Deno.cwd());
  const result = await stage.execute(ctx);
  // workDir は変更されない
  assertEquals(result.workDir, Deno.cwd());
});

// --- execute with invalid base branch ---

Deno.test("WorktreeStage execute throws on invalid base branch", async () => {
  await withTempRepo(async (repoRoot) => {
    const profile: Profile = {
      ...testProfile,
      worktree: { base: "nonexistent-branch-xyz", onCreate: "" },
    };
    const config: Config = { default: "test", profiles: { test: profile } };
    const stage = new WorktreeStage();
    const ctx = createContext(config, profile, "test", repoRoot);

    try {
      await stage.execute(ctx);
      assertEquals(true, false, "Should have thrown");
    } catch (err) {
      assertStringIncludes((err as Error).message, "not found");
    }
  });
});

// --- execute reuses existing worktree ---

Deno.test("WorktreeStage execute reuses existing worktree when user selects it", async () => {
  await withTempRepo(async (repoRoot) => {
    // まず worktree を 1 つ作成
    const stage1 = new WorktreeStage();
    const ctx1 = createContext(testConfig, testProfile, "test", repoRoot);
    const next1 = await stage1.execute(ctx1);
    const firstWorktreePath = next1.workDir;

    // 2 回目の execute: 既存 worktree が見つかる → "1" で再利用
    await withMockedPrompts(["1"], async () => {
      const stage2 = new WorktreeStage();
      const ctx2 = createContext(testConfig, testProfile, "test", repoRoot);
      const next2 = await stage2.execute(ctx2);

      // 再利用された worktree のパスが一致
      assertEquals(next2.workDir, firstWorktreePath);
      assertEquals(next2.mountDir, repoRoot);
    });

    // cleanup
    const branchName =
      (await $`git -C ${firstWorktreePath} branch --show-current`.text())
        .trim();
    await $`git -C ${repoRoot} worktree remove --force ${firstWorktreePath}`
      .quiet("both");
    await $`git -C ${repoRoot} branch -D ${branchName}`.quiet("both");
  });
});

// --- execute creates new worktree when user declines reuse ---

Deno.test("WorktreeStage execute creates new worktree when user declines reuse", async () => {
  await withTempRepo(async (repoRoot) => {
    // まず worktree を 1 つ作成
    const stage1 = new WorktreeStage();
    const ctx1 = createContext(testConfig, testProfile, "test", repoRoot);
    const next1 = await stage1.execute(ctx1);
    const firstWorktreePath = next1.workDir;

    // 2 回目の execute: "0" で新規作成
    await withMockedPrompts(["0"], async () => {
      const stage2 = new WorktreeStage();
      const ctx2 = createContext(testConfig, testProfile, "test", repoRoot);
      const next2 = await stage2.execute(ctx2);

      // 異なるパスの worktree が作られた
      assertEquals(next2.workDir !== firstWorktreePath, true);
      assertEquals(next2.mountDir, repoRoot);

      // cleanup: 2つ目
      const branchName2 =
        (await $`git -C ${next2.workDir} branch --show-current`.text()).trim();
      await $`git -C ${repoRoot} worktree remove --force ${next2.workDir}`
        .quiet("both");
      await $`git -C ${repoRoot} branch -D ${branchName2}`.quiet("both");
    });

    // cleanup: 1つ目
    const branchName1 =
      (await $`git -C ${firstWorktreePath} branch --show-current`.text())
        .trim();
    await $`git -C ${repoRoot} worktree remove --force ${firstWorktreePath}`
      .quiet("both");
    await $`git -C ${repoRoot} branch -D ${branchName1}`.quiet("both");
  });
});

// --- execute with onCreate hook ---

Deno.test("WorktreeStage execute runs onCreate hook", async () => {
  await withTempRepo(async (repoRoot) => {
    const profile: Profile = {
      ...testProfile,
      worktree: { base: "HEAD", onCreate: "touch on-create-marker.txt" },
    };
    const config: Config = { default: "test", profiles: { test: profile } };
    const stage = new WorktreeStage();
    const ctx = createContext(config, profile, "test", repoRoot);
    const next = await stage.execute(ctx);

    // onCreate で作られたファイルが存在する
    const markerExists = await Deno.stat(
      path.join(next.workDir, "on-create-marker.txt"),
    ).then(() => true, () => false);
    assertEquals(markerExists, true);

    // cleanup
    const branchName =
      (await $`git -C ${next.workDir} branch --show-current`.text()).trim();
    await $`git -C ${repoRoot} worktree remove --force ${next.workDir}`.quiet(
      "both",
    );
    await $`git -C ${repoRoot} branch -D ${branchName}`.quiet("both");
  });
});
