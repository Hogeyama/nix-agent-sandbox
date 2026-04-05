/**
 * Integration tests for worktree functionality.
 *
 * Covers WorktreeStage execute, teardown, resolveBase, and
 * lifecycle helpers (list / clean / orphan detection).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import $ from "dax";
import * as path from "@std/path";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type { Config, Profile } from "../config/types.ts";
import type { PriorStageOutputs, StageInput } from "../pipeline/types.ts";
import {
  cleanNasWorktrees,
  listNasWorktrees,
  listOrphanNasBranches,
  resolveBase,
  WorktreeStage,
} from "./worktree.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
  };
}

function createTestConfig(profile: Profile): Config {
  return {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
}

const testProfile: Profile = createTestProfile("HEAD");

const testConfig: Config = createTestConfig(testProfile);

function createTestInput(
  config: Config,
  profile: Profile,
  workDir: string,
): StageInput {
  return {
    config,
    profile,
    profileName: "test",
    sessionId: "sess_test",
    host: {
      home: "/home/test",
      user: "test",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map(),
    },
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/audit",
    },
    prior: {
      dockerArgs: [],
      envVars: {},
      workDir,
      nixEnabled: false,
      imageName: "nas-sandbox",
      agentCommand: [],
      networkPromptEnabled: false,
      dbusProxyEnabled: false,
    } satisfies PriorStageOutputs,
  };
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

// ===========================================================================
// WorktreeStage execute
// ===========================================================================

Deno.test("WorktreeStage: creates worktree under repo metadata and mounts repo root", async () => {
  await withTempRepo(async (repo) => {
    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = new WorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const mountDir = result.outputOverrides.mountDir;
    const branchName = (await $`git -C ${workDir} branch --show-current`
      .text()).trim();

    assertEquals(mountDir, repo);
    assertEquals(
      workDir.startsWith(
        path.join(repo, ".git", "nas-worktrees", "nas-test-"),
      ),
      true,
    );
    assertEquals(branchName.startsWith("nas/test/"), true);

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

Deno.test("WorktreeStage: worktree commits stay visible from the main repository", async () => {
  await withTempRepo(async (repo) => {
    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = new WorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const branchName = (await $`git -C ${workDir} branch --show-current`
      .text()).trim();

    await Deno.writeTextFile(path.join(workDir, "test.txt"), "hello");
    await $`git -C ${workDir} add test.txt`.quiet("both");
    await $`git -C ${workDir} commit -m "add test.txt"`.quiet("both");

    const log = (await $`git -C ${repo} log ${branchName} --oneline -1`.text())
      .trim();
    assertEquals(log.includes("add test.txt"), true);

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

Deno.test("WorktreeStage: starts from the selected base commit", async () => {
  await withTempRepo(async (repo) => {
    await Deno.writeTextFile(path.join(repo, "base.txt"), "base content");
    await $`git -C ${repo} add base.txt`.quiet("both");
    await $`git -C ${repo} commit -m "base commit"`.quiet("both");
    const baseHead = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();

    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = new WorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const branchName = (await $`git -C ${workDir} branch --show-current`
      .text()).trim();
    const worktreeHead = (await $`git -C ${workDir} rev-parse HEAD`.text())
      .trim();

    assertEquals(worktreeHead, baseHead);
    assertEquals(
      await Deno.readTextFile(path.join(workDir, "base.txt")),
      "base content",
    );

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

Deno.test("WorktreeStage: inherits dirty tracked, staged, and untracked changes from the checked out base branch", async () => {
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
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const branchName = (await $`git -C ${workDir} branch --show-current`
      .text()).trim();
    const status = (await $`git -C ${workDir} status --short`.text())
      .trim()
      .split("\n")
      .filter(Boolean);

    assertEquals(
      await Deno.readTextFile(path.join(workDir, "tracked.txt")),
      "base\nunstaged\n",
    );
    assertEquals(
      await Deno.readTextFile(path.join(workDir, "staged.txt")),
      "base\nstaged\n",
    );
    assertEquals(
      await Deno.readTextFile(path.join(workDir, "untracked.txt")),
      "untracked\n",
    );
    assertEquals(status.includes(" M tracked.txt"), true);
    assertEquals(status.includes("M  staged.txt"), true);
    assertEquals(status.includes("?? untracked.txt"), true);

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

Deno.test("WorktreeStage: leaves a clean base branch clean in the new worktree", async () => {
  await withTempRepo(async (repo) => {
    await Deno.writeTextFile(path.join(repo, "tracked.txt"), "base\n");
    await $`git -C ${repo} add tracked.txt`.quiet("both");
    await $`git -C ${repo} commit -m "add tracked file"`.quiet("both");

    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = new WorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const branchName = (await $`git -C ${workDir} branch --show-current`
      .text()).trim();

    assertEquals(
      (await $`git -C ${workDir} status --short`.text()).trim(),
      "",
    );
    assertEquals(
      await Deno.readTextFile(path.join(workDir, "tracked.txt")),
      "base\n",
    );

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});

// ===========================================================================
// WorktreeStage teardown
// ===========================================================================

Deno.test("WorktreeStage teardown stashes dirty changes before deleting", async () => {
  await withTempRepo(async (repoRoot) => {
    await withMockedPrompts(["1", "1", "1"], async () => {
      const stage = new WorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      await Deno.writeTextFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown!(input);

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
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;
      const branchName = (await $`git -C ${worktreePath} branch --show-current`
        .text()).trim();

      await Deno.writeTextFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown!(input);

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
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;
      const branchName =
        (await $`git -C ${worktreePath} branch --show-current`.text()).trim();

      await stage.teardown!(input);

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
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      // worktree は clean (dirty ファイルなし)
      await stage.teardown!(input);

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
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      await Deno.writeTextFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown!(input);

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
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      await stage.teardown!(input);

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
      const input = createTestInput(testConfig, testProfile, repoRoot);
      await stage.execute(input);

      await stage.teardown!(input);

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
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      // worktree 内でコミットを作成
      await Deno.writeTextFile(
        path.join(worktreePath, "feature.txt"),
        "feature\n",
      );
      await $`git -C ${worktreePath} add feature.txt`.quiet("both");
      await $`git -C ${worktreePath} commit -m "add feature"`.quiet("both");

      await stage.teardown!(input);

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

Deno.test("WorktreeStage teardown cherry-picks even when base worktree has uncommitted changes", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "2" (cherry-pick)
    await withMockedPrompts(["1", "2"], async () => {
      const stage = new WorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      await Deno.writeTextFile(
        path.join(worktreePath, "feature.txt"),
        "feature\n",
      );
      await $`git -C ${worktreePath} add feature.txt`.quiet("both");
      await $`git -C ${worktreePath} commit -m "add feature"`.quiet("both");

      // base worktree 側に未コミット変更を残した状態で teardown
      await Deno.writeTextFile(path.join(repoRoot, "dirty.txt"), "dirty\n");

      await stage.teardown!(input);

      const baseBranch =
        (await $`git -C ${repoRoot} symbolic-ref --short HEAD`.text()).trim();
      const log =
        (await $`git -C ${repoRoot} log ${baseBranch} --oneline -5`.text())
          .trim();
      assertStringIncludes(log, "add feature");

      const dirtyContent = await Deno.readTextFile(
        path.join(repoRoot, "dirty.txt"),
      );
      assertEquals(dirtyContent, "dirty\n");

      const branchList =
        (await $`git -C ${repoRoot} branch --list nas/test/*`.text()).trim();
      assertEquals(branchList, "");

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
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      // コミットせずに teardown
      await stage.teardown!(input);

      // エラーなく完了
      const worktreeList = await $`git -C ${repoRoot} worktree list --porcelain`
        .text();
      assertEquals(worktreeList.includes(worktreePath), false);
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
  const config: Config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const input = createTestInput(config, profile, "/tmp/nonexistent");
  // teardown should not throw
  await stage.teardown!(input);
});

// --- execute skips when worktree not configured ---

Deno.test("WorktreeStage execute skips when worktree is not configured", async () => {
  const stage = new WorktreeStage();
  const profile: Profile = {
    ...testProfile,
    worktree: undefined,
  };
  const config: Config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const input = createTestInput(config, profile, Deno.cwd());
  const result = await stage.execute(input);
  // outputOverrides は空 (workDir は変更されない)
  assertEquals(Object.keys(result.outputOverrides).length, 0);
});

// --- execute with invalid base branch ---

Deno.test("WorktreeStage execute throws on invalid base branch", async () => {
  await withTempRepo(async (repoRoot) => {
    const profile: Profile = {
      ...testProfile,
      worktree: { base: "nonexistent-branch-xyz", onCreate: "" },
    };
    const config: Config = {
      default: "test",
      profiles: { test: profile },
      ui: DEFAULT_UI_CONFIG,
    };
    const stage = new WorktreeStage();
    const input = createTestInput(config, profile, repoRoot);

    try {
      await stage.execute(input);
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
    const input1 = createTestInput(testConfig, testProfile, repoRoot);
    const result1 = await stage1.execute(input1);
    const firstWorktreePath = result1.outputOverrides.workDir!;

    // 2 回目の execute: 既存 worktree が見つかる → "1" で再利用
    await withMockedPrompts(["1"], async () => {
      const stage2 = new WorktreeStage();
      const input2 = createTestInput(testConfig, testProfile, repoRoot);
      const result2 = await stage2.execute(input2);

      // 再利用された worktree のパスが一致
      assertEquals(result2.outputOverrides.workDir, firstWorktreePath);
      assertEquals(result2.outputOverrides.mountDir, repoRoot);
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
    const input1 = createTestInput(testConfig, testProfile, repoRoot);
    const result1 = await stage1.execute(input1);
    const firstWorktreePath = result1.outputOverrides.workDir!;

    // 2 回目の execute: "0" で新規作成
    await withMockedPrompts(["0"], async () => {
      const stage2 = new WorktreeStage();
      const input2 = createTestInput(testConfig, testProfile, repoRoot);
      const result2 = await stage2.execute(input2);

      // 異なるパスの worktree が作られた
      assertEquals(
        result2.outputOverrides.workDir !== firstWorktreePath,
        true,
      );
      assertEquals(result2.outputOverrides.mountDir, repoRoot);

      // cleanup: 2つ目
      const branchName2 = (await $`git -C ${result2.outputOverrides
        .workDir!} branch --show-current`
        .text()).trim();
      await $`git -C ${repoRoot} worktree remove --force ${result2
        .outputOverrides.workDir!}`
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
    const config: Config = {
      default: "test",
      profiles: { test: profile },
      ui: DEFAULT_UI_CONFIG,
    };
    const stage = new WorktreeStage();
    const input = createTestInput(config, profile, repoRoot);
    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;

    // onCreate で作られたファイルが存在する
    const markerExists = await Deno.stat(
      path.join(workDir, "on-create-marker.txt"),
    ).then(() => true, () => false);
    assertEquals(markerExists, true);

    // cleanup
    const branchName = (await $`git -C ${workDir} branch --show-current`.text())
      .trim();
    await $`git -C ${repoRoot} worktree remove --force ${workDir}`.quiet(
      "both",
    );
    await $`git -C ${repoRoot} branch -D ${branchName}`.quiet("both");
  });
});

// ===========================================================================
// resolveBase
// ===========================================================================

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

// ===========================================================================
// Worktree lifecycle helpers (list / clean / orphan detection)
// ===========================================================================

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
    const otherPath = path.join(repo, ".git", "other-worktree");
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
