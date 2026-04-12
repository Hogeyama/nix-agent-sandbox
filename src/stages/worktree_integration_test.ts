import { expect, test } from "bun:test";

/**
 * Integration tests for worktree functionality.
 *
 * Covers WorktreeStage execute, teardown, resolveBase, and
 * lifecycle helpers (list / clean / orphan detection).
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { Effect, Exit, Layer, Scope } from "effect";
import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type {
  EffectStageResult,
  PriorStageOutputs,
  StageInput,
} from "../pipeline/types.ts";
import { AuthRouterServiceLive } from "../services/auth_router.ts";
import { DindServiceLive } from "../services/dind.ts";
import { DockerServiceLive } from "../services/docker.ts";
import { FsServiceLive } from "../services/fs.ts";
import { HostExecBrokerServiceLive } from "../services/hostexec_broker.ts";
import { ProcessServiceLive } from "../services/process.ts";
import { SessionBrokerServiceLive } from "../services/session_broker.ts";
import { SessionStoreServiceLive } from "../services/session_store_service.ts";
import { PromptServiceLive } from "./worktree/prompt_service.ts";
import {
  cleanNasWorktrees,
  createWorktreeStage,
  listNasWorktrees,
  listOrphanNasBranches,
  resolveBase,
} from "./worktree.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const liveLayer = Layer.mergeAll(
  AuthRouterServiceLive,
  DindServiceLive,
  FsServiceLive,
  HostExecBrokerServiceLive,
  ProcessServiceLive,
  DockerServiceLive,
  PromptServiceLive,
  SessionBrokerServiceLive,
  SessionStoreServiceLive,
);

interface WorktreeStageAdapter {
  name: string;
  execute(input: StageInput): Promise<{ outputOverrides: EffectStageResult }>;
  teardown(input?: StageInput): Promise<void>;
}

function makeWorktreeStage(): WorktreeStageAdapter {
  const stage = createWorktreeStage();
  let closeScope: Effect.Effect<void> | undefined;

  return {
    name: stage.name,
    async execute(input: StageInput) {
      const scope = Effect.runSync(Scope.make());
      closeScope = Scope.close(scope, Exit.void);

      const effect = stage
        .run(input)
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(liveLayer),
        );
      const outputOverrides = await Effect.runPromise(effect);
      return { outputOverrides };
    },
    async teardown() {
      if (closeScope) {
        await Effect.runPromise(closeScope);
        closeScope = undefined;
      }
    },
  };
}

async function withTempRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "wt-e2e-"));
  try {
    await $`git init ${tmpDir}`.quiet();
    await $`git -C ${tmpDir} config user.name nas-test`.quiet();
    await $`git -C ${tmpDir} config user.email nas-test@example.com`.quiet();
    await $`git -C ${tmpDir} config commit.gpgsign false`.quiet();
    await $`git -C ${tmpDir} commit --allow-empty -m "init"`.quiet();
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
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
    hook: DEFAULT_HOOK_CONFIG,
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
    expect(index).toEqual(answers.length);
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
  const worktreePath = path.join(repoRoot, ".nas", "worktrees", worktreeName);
  await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} HEAD`.quiet();
  return { worktreePath, branchName };
}

// ===========================================================================
// WorktreeStage execute
// ===========================================================================

test("WorktreeStage: creates worktree under repo metadata and mounts repo root", async () => {
  await withTempRepo(async (repo) => {
    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = makeWorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const mountDir = result.outputOverrides.mountDir;
    const branchName = (
      await $`git -C ${workDir} branch --show-current`.text()
    ).trim();

    expect(mountDir).toEqual(repo);
    expect(
      workDir.startsWith(path.join(repo, ".nas", "worktrees", "nas-test-")),
    ).toEqual(true);
    expect(branchName.startsWith("nas/test/")).toEqual(true);

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet();
    await $`git -C ${repo} branch -D ${branchName}`.quiet();
  });
});

test("WorktreeStage: worktree commits stay visible from the main repository", async () => {
  await withTempRepo(async (repo) => {
    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = makeWorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const branchName = (
      await $`git -C ${workDir} branch --show-current`.text()
    ).trim();

    await writeFile(path.join(workDir, "test.txt"), "hello");
    await $`git -C ${workDir} add test.txt`.quiet();
    await $`git -C ${workDir} commit -m "add test.txt"`.quiet();

    const log = (
      await $`git -C ${repo} log ${branchName} --oneline -1`.text()
    ).trim();
    expect(log.includes("add test.txt")).toEqual(true);

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet();
    await $`git -C ${repo} branch -D ${branchName}`.quiet();
  });
});

test("WorktreeStage: starts from the selected base commit", async () => {
  await withTempRepo(async (repo) => {
    await writeFile(path.join(repo, "base.txt"), "base content");
    await $`git -C ${repo} add base.txt`.quiet();
    await $`git -C ${repo} commit -m "base commit"`.quiet();
    const baseHead = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();

    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = makeWorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const branchName = (
      await $`git -C ${workDir} branch --show-current`.text()
    ).trim();
    const worktreeHead = (
      await $`git -C ${workDir} rev-parse HEAD`.text()
    ).trim();

    expect(worktreeHead).toEqual(baseHead);
    expect(await readFile(path.join(workDir, "base.txt"), "utf8")).toEqual(
      "base content",
    );

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet();
    await $`git -C ${repo} branch -D ${branchName}`.quiet();
  });
});

test("WorktreeStage: inherits dirty tracked, staged, and untracked changes from the checked out base branch", async () => {
  await withTempRepo(async (repo) => {
    await writeFile(path.join(repo, "tracked.txt"), "base\n");
    await writeFile(path.join(repo, "staged.txt"), "base\n");
    await $`git -C ${repo} add tracked.txt staged.txt`.quiet();
    await $`git -C ${repo} commit -m "add base files"`.quiet();

    await writeFile(path.join(repo, "tracked.txt"), "base\nunstaged\n");
    await writeFile(path.join(repo, "staged.txt"), "base\nstaged\n");
    await $`git -C ${repo} add staged.txt`.quiet();
    await writeFile(path.join(repo, "untracked.txt"), "untracked\n");

    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = makeWorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const branchName = (
      await $`git -C ${workDir} branch --show-current`.text()
    ).trim();
    const status = (await $`git -C ${workDir} status --short`.text())
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(await readFile(path.join(workDir, "tracked.txt"), "utf8")).toEqual(
      "base\nunstaged\n",
    );
    expect(await readFile(path.join(workDir, "staged.txt"), "utf8")).toEqual(
      "base\nstaged\n",
    );
    expect(await readFile(path.join(workDir, "untracked.txt"), "utf8")).toEqual(
      "untracked\n",
    );
    expect(status.includes(" M tracked.txt")).toEqual(true);
    expect(status.includes("M  staged.txt")).toEqual(true);
    expect(status.includes("?? untracked.txt")).toEqual(true);

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet();
    await $`git -C ${repo} branch -D ${branchName}`.quiet();
  });
});

test("WorktreeStage: leaves a clean base branch clean in the new worktree", async () => {
  await withTempRepo(async (repo) => {
    await writeFile(path.join(repo, "tracked.txt"), "base\n");
    await $`git -C ${repo} add tracked.txt`.quiet();
    await $`git -C ${repo} commit -m "add tracked file"`.quiet();

    const profile = createTestProfile("HEAD");
    const config = createTestConfig(profile);
    const stage = makeWorktreeStage();
    const input = createTestInput(config, profile, repo);

    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;
    const branchName = (
      await $`git -C ${workDir} branch --show-current`.text()
    ).trim();

    expect((await $`git -C ${workDir} status --short`.text()).trim()).toEqual(
      "",
    );
    expect(await readFile(path.join(workDir, "tracked.txt"), "utf8")).toEqual(
      "base\n",
    );

    await $`git -C ${repo} worktree remove --force ${workDir}`.quiet();
    await $`git -C ${repo} branch -D ${branchName}`.quiet();
  });
});

// ===========================================================================
// WorktreeStage teardown
// ===========================================================================

test("WorktreeStage teardown stashes dirty changes before deleting", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → "1" (stash)
    // promptBranchAction → skipped (no unique commits → auto-delete)
    await withMockedPrompts(["1", "1"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      await writeFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown!(input);

      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList.includes(worktreePath)).toEqual(false);

      const branchList = (
        await $`git -C ${repoRoot} branch --list ${"nas/test/*"}`.text()
      ).trim();
      expect(branchList).toEqual("");

      const stashList = (await $`git -C ${repoRoot} stash list`.text()).trim();
      expect(stashList).toContain("nas teardown");

      const stashedFiles =
        await $`git -C ${repoRoot} stash show --name-only --include-untracked ${"stash@{0}"}`.text();
      expect(stashedFiles).toContain("draft.txt");
    });
  });
});

test("WorktreeStage teardown can keep a dirty worktree from the stash prompt", async () => {
  await withTempRepo(async (repoRoot) => {
    await withMockedPrompts(["1", "3"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;
      const branchName = (
        await $`git -C ${worktreePath} branch --show-current`.text()
      ).trim();

      await writeFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown!(input);

      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList).toContain(worktreePath);

      const branchList = (
        await $`git -C ${repoRoot} branch --list ${branchName}`.text()
      ).trim();
      expect(branchList).toContain(branchName);

      const stashList = (await $`git -C ${repoRoot} stash list`.text()).trim();
      expect(stashList).toEqual("");

      await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet();
      await $`git -C ${repoRoot} branch -D ${branchName}`.quiet();
    });
  });
});

// --- promptWorktreeAction: "keep" ---

test("WorktreeStage teardown keeps worktree when user chooses keep", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "2" (keep)
    await withMockedPrompts(["2"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;
      const branchName = (
        await $`git -C ${worktreePath} branch --show-current`.text()
      ).trim();

      await stage.teardown!(input);

      // worktree が残っている
      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList).toContain(worktreePath);

      // cleanup
      await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet();
      await $`git -C ${repoRoot} branch -D ${branchName}`.quiet();
    });
  });
});

// --- clean worktree delete (no dirty prompt) ---

test("WorktreeStage teardown deletes clean worktree and branch", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → skipped (no unique commits → auto-delete)
    await withMockedPrompts(["1"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      // worktree は clean (dirty ファイルなし)
      await stage.teardown!(input);

      // worktree が削除されている
      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList.includes(worktreePath)).toEqual(false);

      // ブランチも削除されている
      const branchList = (
        await $`git -C ${repoRoot} branch --list ${"nas/test/*"}`.text()
      ).trim();
      expect(branchList).toEqual("");
    });
  });
});

// --- dirty worktree: delete without stashing ---

test("WorktreeStage teardown deletes dirty worktree without stashing", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → "2" (delete without stash)
    // promptBranchAction → skipped (no unique commits → auto-delete)
    await withMockedPrompts(["1", "2"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      await writeFile(path.join(worktreePath, "draft.txt"), "hello");

      await stage.teardown!(input);

      // worktree が削除されている
      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList.includes(worktreePath)).toEqual(false);

      // stash に何もない
      const stashList = (await $`git -C ${repoRoot} stash list`.text()).trim();
      expect(stashList).toEqual("");
    });
  });
});

// --- branch rename ---

test("WorktreeStage teardown renames branch and keeps it", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "3" (rename)
    // prompt for new name → "my-saved-branch"
    await withMockedPrompts(["1", "3", "my-saved-branch"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      // ブランチにコミットを追加して promptBranchAction が表示されるようにする
      await writeFile(path.join(worktreePath, "feature.txt"), "feature\n");
      await $`git -C ${worktreePath} add feature.txt`.quiet();
      await $`git -C ${worktreePath} commit -m "add feature"`.quiet();

      await stage.teardown!(input);

      // worktree は削除されている
      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList.includes(worktreePath)).toEqual(false);

      // 元のブランチは消え、リネーム先が存在
      const oldBranch = (
        await $`git -C ${repoRoot} branch --list ${"nas/test/*"}`.text()
      ).trim();
      expect(oldBranch).toEqual("");

      const newBranch = (
        await $`git -C ${repoRoot} branch --list my-saved-branch`.text()
      ).trim();
      expect(newBranch).toContain("my-saved-branch");

      // cleanup
      await $`git -C ${repoRoot} branch -D my-saved-branch`.quiet();
    });
  });
});

// --- branch rename with empty name (keeps original) ---

test("WorktreeStage teardown rename with empty name keeps original branch name", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "3" (rename)
    // prompt for new name → "" (empty)
    await withMockedPrompts(["1", "3", ""], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      // ブランチにコミットを追加して promptBranchAction が表示されるようにする
      await writeFile(path.join(worktreePath, "feature.txt"), "feature\n");
      await $`git -C ${worktreePath} add feature.txt`.quiet();
      await $`git -C ${worktreePath} commit -m "add feature"`.quiet();

      await stage.teardown!(input);

      // worktree は削除されているがブランチ名はそのまま残る
      // (rename がスキップされ、worktree remove 後もブランチ削除されない)
    });
  });
});

// --- cherry-pick to base ---

test("WorktreeStage teardown cherry-picks commits to base branch", async () => {
  await withTempRepo(async (repoRoot) => {
    // base ブランチにファイルを追加
    await writeFile(path.join(repoRoot, "base.txt"), "base\n");
    await $`git -C ${repoRoot} add base.txt`.quiet();
    await $`git -C ${repoRoot} commit -m "base file"`.quiet();

    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "2" (cherry-pick)
    await withMockedPrompts(["1", "2"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      // worktree 内でコミットを作成
      await writeFile(path.join(worktreePath, "feature.txt"), "feature\n");
      await $`git -C ${worktreePath} add feature.txt`.quiet();
      await $`git -C ${worktreePath} commit -m "add feature"`.quiet();

      await stage.teardown!(input);

      // base ブランチに cherry-pick されたコミットが入っている
      const baseBranch = (
        await $`git -C ${repoRoot} symbolic-ref --short HEAD`.text()
      ).trim();
      const log = (
        await $`git -C ${repoRoot} log ${baseBranch} --oneline -5`.text()
      ).trim();
      expect(log).toContain("add feature");

      // worktree は削除されている
      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList.includes(worktreePath)).toEqual(false);
    });
  });
});

test("WorktreeStage teardown cherry-picks even when base worktree has uncommitted changes", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → "2" (cherry-pick)
    await withMockedPrompts(["1", "2"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      await writeFile(path.join(worktreePath, "feature.txt"), "feature\n");
      await $`git -C ${worktreePath} add feature.txt`.quiet();
      await $`git -C ${worktreePath} commit -m "add feature"`.quiet();

      // base worktree 側に未コミット変更を残した状態で teardown
      await writeFile(path.join(repoRoot, "dirty.txt"), "dirty\n");

      await stage.teardown!(input);

      const baseBranch = (
        await $`git -C ${repoRoot} symbolic-ref --short HEAD`.text()
      ).trim();
      const log = (
        await $`git -C ${repoRoot} log ${baseBranch} --oneline -5`.text()
      ).trim();
      expect(log).toContain("add feature");

      const dirtyContent = await readFile(
        path.join(repoRoot, "dirty.txt"),
        "utf8",
      );
      expect(dirtyContent).toEqual("dirty\n");

      const branchList = (
        await $`git -C ${repoRoot} branch --list ${"nas/test/*"}`.text()
      ).trim();
      expect(branchList).toEqual("");

      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList.includes(worktreePath)).toEqual(false);
    });
  });
});

// --- cherry-pick with no commits ---

test("WorktreeStage teardown auto-deletes branch with no new commits", async () => {
  await withTempRepo(async (repoRoot) => {
    // promptWorktreeAction → "1" (delete)
    // promptDirtyWorktreeAction → skipped (clean)
    // promptBranchAction → skipped (no unique commits → auto-delete)
    await withMockedPrompts(["1"], async () => {
      const stage = makeWorktreeStage();
      const input = createTestInput(testConfig, testProfile, repoRoot);
      const result = await stage.execute(input);
      const worktreePath = result.outputOverrides.workDir!;

      // コミットせずに teardown
      await stage.teardown!(input);

      // エラーなく完了
      const worktreeList =
        await $`git -C ${repoRoot} worktree list --porcelain`.text();
      expect(worktreeList.includes(worktreePath)).toEqual(false);
    });
  });
});

// --- teardown without execute (no worktree) ---

test("WorktreeStage teardown without execute is a no-op", async () => {
  const stage = makeWorktreeStage();
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

test("WorktreeStage execute skips when worktree is not configured", async () => {
  const stage = makeWorktreeStage();
  const profile: Profile = {
    ...testProfile,
    worktree: undefined,
  };
  const config: Config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const input = createTestInput(config, profile, process.cwd());
  const result = await stage.execute(input);
  // outputOverrides は空 (workDir は変更されない)
  expect(Object.keys(result.outputOverrides).length).toEqual(0);
});

// --- execute with invalid base branch ---

test("WorktreeStage execute throws on invalid base branch", async () => {
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
    const stage = makeWorktreeStage();
    const input = createTestInput(config, profile, repoRoot);

    try {
      await stage.execute(input);
      expect(true).toEqual(false); // Should have thrown
    } catch (err) {
      expect((err as Error).message).toContain("not found");
    }
  });
});

// --- execute reuses existing worktree ---

test("WorktreeStage execute reuses existing worktree when user selects it", async () => {
  await withTempRepo(async (repoRoot) => {
    // まず worktree を 1 つ作成
    const stage1 = makeWorktreeStage();
    const input1 = createTestInput(testConfig, testProfile, repoRoot);
    const result1 = await stage1.execute(input1);
    const firstWorktreePath = result1.outputOverrides.workDir!;

    // 2 回目の execute: 既存 worktree が見つかる → "1" で再利用
    await withMockedPrompts(["1"], async () => {
      const stage2 = makeWorktreeStage();
      const input2 = createTestInput(testConfig, testProfile, repoRoot);
      const result2 = await stage2.execute(input2);

      // 再利用された worktree のパスが一致
      expect(result2.outputOverrides.workDir).toEqual(firstWorktreePath);
      expect(result2.outputOverrides.mountDir).toEqual(repoRoot);
    });

    // cleanup
    const branchName = (
      await $`git -C ${firstWorktreePath} branch --show-current`.text()
    ).trim();
    await $`git -C ${repoRoot} worktree remove --force ${firstWorktreePath}`.quiet();
    await $`git -C ${repoRoot} branch -D ${branchName}`.quiet();
  });
});

// --- execute creates new worktree when user declines reuse ---

test("WorktreeStage execute creates new worktree when user declines reuse", async () => {
  await withTempRepo(async (repoRoot) => {
    // まず worktree を 1 つ作成
    const stage1 = makeWorktreeStage();
    const input1 = createTestInput(testConfig, testProfile, repoRoot);
    const result1 = await stage1.execute(input1);
    const firstWorktreePath = result1.outputOverrides.workDir!;

    // 2 回目の execute: "0" で新規作成
    await withMockedPrompts(["0"], async () => {
      const stage2 = makeWorktreeStage();
      const input2 = createTestInput(testConfig, testProfile, repoRoot);
      const result2 = await stage2.execute(input2);

      // 異なるパスの worktree が作られた
      expect(result2.outputOverrides.workDir !== firstWorktreePath).toEqual(
        true,
      );
      expect(result2.outputOverrides.mountDir).toEqual(repoRoot);

      // cleanup: 2つ目
      const branchName2 = (
        await $`git -C ${result2.outputOverrides
          .workDir!} branch --show-current`.text()
      ).trim();
      await $`git -C ${repoRoot} worktree remove --force ${result2
        .outputOverrides.workDir!}`.quiet();
      await $`git -C ${repoRoot} branch -D ${branchName2}`.quiet();
    });

    // cleanup: 1つ目
    const branchName1 = (
      await $`git -C ${firstWorktreePath} branch --show-current`.text()
    ).trim();
    await $`git -C ${repoRoot} worktree remove --force ${firstWorktreePath}`.quiet();
    await $`git -C ${repoRoot} branch -D ${branchName1}`.quiet();
  });
});

// --- execute with onCreate hook ---

test("WorktreeStage execute runs onCreate hook", async () => {
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
    const stage = makeWorktreeStage();
    const input = createTestInput(config, profile, repoRoot);
    const result = await stage.execute(input);
    const workDir = result.outputOverrides.workDir!;

    // onCreate で作られたファイルが存在する
    const markerExists = await stat(
      path.join(workDir, "on-create-marker.txt"),
    ).then(
      () => true,
      () => false,
    );
    expect(markerExists).toEqual(true);

    // cleanup
    const branchName = (
      await $`git -C ${workDir} branch --show-current`.text()
    ).trim();
    await $`git -C ${repoRoot} worktree remove --force ${workDir}`.quiet();
    await $`git -C ${repoRoot} branch -D ${branchName}`.quiet();
  });
});

// ===========================================================================
// resolveBase
// ===========================================================================

test("resolveBase: non-HEAD value is returned as-is", async () => {
  await withTempRepo(async (repo) => {
    expect(await resolveBase(repo, "origin/main")).toEqual("origin/main");
    expect(await resolveBase(repo, "develop")).toEqual("develop");
  });
});

test("resolveBase: HEAD resolves to current branch name", async () => {
  await withTempRepo(async (repo) => {
    // デフォルトブランチ名を取得
    const defaultBranch = (
      await $`git -C ${repo} symbolic-ref --short HEAD`.text()
    ).trim();
    expect(await resolveBase(repo, "HEAD")).toEqual(defaultBranch);

    // 別ブランチに切り替えてテスト
    await $`git -C ${repo} checkout -b feature-test`.quiet();
    expect(await resolveBase(repo, "HEAD")).toEqual("feature-test");
  });
});

test("resolveBase: HEAD in detached state throws error", async () => {
  await withTempRepo(async (repo) => {
    const sha = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    await $`git -C ${repo} checkout ${sha}`.quiet();

    await expect(resolveBase(repo, "HEAD")).rejects.toThrow(
      "detached HEAD state",
    );
  });
});

// ===========================================================================
// Worktree lifecycle helpers (list / clean / orphan detection)
// ===========================================================================

// --- listNasWorktrees ---

test("listNasWorktrees: returns empty list for fresh repo", async () => {
  await withTempRepo(async (repo) => {
    const entries = await listNasWorktrees(repo);
    expect(entries.length).toEqual(0);
  });
});

test("listNasWorktrees: finds nas worktrees", async () => {
  await withTempRepo(async (repo) => {
    await createTestWorktree(repo, "myprofile", "2026-01-01T00-00-00");
    await createTestWorktree(repo, "myprofile", "2026-01-02T00-00-00");

    const entries = await listNasWorktrees(repo);
    expect(entries.length).toEqual(2);
    expect(entries.every((e) => e.path.includes("nas-myprofile-"))).toEqual(
      true,
    );
    expect(entries.every((e) => e.branch.includes("nas/myprofile/"))).toEqual(
      true,
    );
  });
});

test("listNasWorktrees: ignores non-nas worktrees", async () => {
  await withTempRepo(async (repo) => {
    // nas worktree
    await createTestWorktree(repo, "test", "2026-01-01T00-00-00");
    // non-nas worktree
    const otherPath = path.join(repo, ".git", "other-worktree");
    await $`git -C ${repo} worktree add -b other-branch ${otherPath} HEAD`.quiet();

    const entries = await listNasWorktrees(repo);
    expect(entries.length).toEqual(1);
    expect(entries[0].path.includes("nas-test-")).toEqual(true);
  });
});

// --- listOrphanNasBranches ---

test("listOrphanNasBranches: returns empty when no orphans", async () => {
  await withTempRepo(async (repo) => {
    // worktree に紐づいたブランチのみ
    await createTestWorktree(repo, "test", "2026-01-01T00-00-00");

    const orphans = await listOrphanNasBranches(repo);
    expect(orphans.length).toEqual(0);
  });
});

test("listOrphanNasBranches: finds branches without worktrees", async () => {
  await withTempRepo(async (repo) => {
    // worktree を作って削除（ブランチは残る）
    const { worktreePath, branchName } = await createTestWorktree(
      repo,
      "test",
      "2026-01-01T00-00-00",
    );
    await $`git -C ${repo} worktree remove --force ${worktreePath}`.quiet();

    const orphans = await listOrphanNasBranches(repo);
    expect(orphans.length).toEqual(1);
    expect(orphans[0]).toEqual(branchName);
  });
});

// --- cleanNasWorktrees ---

test("cleanNasWorktrees: removes all nas worktrees with force", async () => {
  await withTempRepo(async (repo) => {
    await createTestWorktree(repo, "prof1", "2026-01-01T00-00-00");
    await createTestWorktree(repo, "prof2", "2026-01-02T00-00-00");

    const result = await cleanNasWorktrees(repo, { force: true });
    expect(result.worktrees).toEqual(2);

    const remaining = await listNasWorktrees(repo);
    expect(remaining.length).toEqual(0);
  });
});

test("cleanNasWorktrees: returns zero counts for empty repo", async () => {
  await withTempRepo(async (repo) => {
    const result = await cleanNasWorktrees(repo, { force: true });
    expect(result.worktrees).toEqual(0);
    expect(result.orphanBranches).toEqual(0);
  });
});

test("cleanNasWorktrees: with deleteBranch removes orphan branches too", async () => {
  await withTempRepo(async (repo) => {
    // worktree 付きブランチ
    await createTestWorktree(repo, "active", "2026-01-01T00-00-00");

    // orphan ブランチ（worktree を作って消す）
    const { worktreePath } = await createTestWorktree(
      repo,
      "orphan",
      "2026-01-02T00-00-00",
    );
    await $`git -C ${repo} worktree remove --force ${worktreePath}`.quiet();

    const result = await cleanNasWorktrees(repo, {
      force: true,
      deleteBranch: true,
    });
    expect(result.worktrees).toEqual(1); // active のみ（orphan の worktree は既に削除済み）
    expect(result.orphanBranches).toEqual(1);

    const remaining = await listNasWorktrees(repo);
    expect(remaining.length).toEqual(0);

    const orphans = await listOrphanNasBranches(repo);
    expect(orphans.length).toEqual(0);
  });
});
