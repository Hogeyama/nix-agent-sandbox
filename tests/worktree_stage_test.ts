/**
 * E2E tests: WorktreeStage execute
 *
 * list/clean/resolveBase の詳細は専用テストに任せ、
 * ここでは WorktreeStage 固有の振る舞いだけを検証する。
 */

import { assertEquals } from "@std/assert";
import $ from "dax";
import * as path from "@std/path";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../src/config/types.ts";
import type { Config, Profile } from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import { WorktreeStage } from "../src/stages/worktree.ts";

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

Deno.test("WorktreeStage: creates worktree under repo metadata and mounts repo root", async () => {
  await withTempRepo(async (repo) => {
    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = new WorktreeStage();
    const ctx = createContext(config, profile, "test", repo);

    const next = await stage.execute(ctx);
    const branchName = (await $`git -C ${next.workDir} branch --show-current`
      .text()).trim();

    assertEquals(next.mountDir, repo);
    assertEquals(
      next.workDir.startsWith(
        path.join(repo, ".git", "nas-worktrees", "nas-test-"),
      ),
      true,
    );
    assertEquals(branchName.startsWith("nas/test/"), true);

    await $`git -C ${repo} worktree remove --force ${next.workDir}`.quiet(
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
    const ctx = createContext(config, profile, "test", repo);

    const next = await stage.execute(ctx);
    const branchName = (await $`git -C ${next.workDir} branch --show-current`
      .text()).trim();

    await Deno.writeTextFile(path.join(next.workDir, "test.txt"), "hello");
    await $`git -C ${next.workDir} add test.txt`.quiet("both");
    await $`git -C ${next.workDir} commit -m "add test.txt"`.quiet("both");

    const log = (await $`git -C ${repo} log ${branchName} --oneline -1`.text())
      .trim();
    assertEquals(log.includes("add test.txt"), true);

    await $`git -C ${repo} worktree remove --force ${next.workDir}`.quiet(
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
    const ctx = createContext(config, profile, "test", repo);

    const next = await stage.execute(ctx);
    const branchName = (await $`git -C ${next.workDir} branch --show-current`
      .text()).trim();
    const worktreeHead = (await $`git -C ${next.workDir} rev-parse HEAD`.text())
      .trim();

    assertEquals(worktreeHead, baseHead);
    assertEquals(
      await Deno.readTextFile(path.join(next.workDir, "base.txt")),
      "base content",
    );

    await $`git -C ${repo} worktree remove --force ${next.workDir}`.quiet(
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
    const ctx = createContext(config, profile, "test", repo);

    const next = await stage.execute(ctx);
    const branchName = (await $`git -C ${next.workDir} branch --show-current`
      .text()).trim();
    const status = (await $`git -C ${next.workDir} status --short`.text())
      .trim()
      .split("\n")
      .filter(Boolean);

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
    assertEquals(status.includes(" M tracked.txt"), true);
    assertEquals(status.includes("M  staged.txt"), true);
    assertEquals(status.includes("?? untracked.txt"), true);

    await $`git -C ${repo} worktree remove --force ${next.workDir}`.quiet(
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
    const ctx = createContext(config, profile, "test", repo);

    const next = await stage.execute(ctx);
    const branchName = (await $`git -C ${next.workDir} branch --show-current`
      .text()).trim();

    assertEquals(
      (await $`git -C ${next.workDir} status --short`.text()).trim(),
      "",
    );
    assertEquals(
      await Deno.readTextFile(path.join(next.workDir, "tracked.txt")),
      "base\n",
    );

    await $`git -C ${repo} worktree remove --force ${next.workDir}`.quiet(
      "both",
    );
    await $`git -C ${repo} branch -D ${branchName}`.quiet("both");
  });
});
