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
import type { PriorStageOutputs, StageInput } from "../src/pipeline/types.ts";
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
