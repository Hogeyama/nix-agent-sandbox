import { assertEquals, assertStringIncludes } from "@std/assert";
import $ from "dax";
import * as path from "@std/path";
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
