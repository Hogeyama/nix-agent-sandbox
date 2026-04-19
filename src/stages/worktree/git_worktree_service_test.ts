import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { Effect, Layer } from "effect";
import { FsServiceLive } from "../../services/fs.ts";
import { ProcessServiceLive } from "../../services/process.ts";
import {
  CherryPickOps,
  CherryPickToBaseOps,
  cherryPickInTmpWorktree,
  cherryPickInWorktree,
  cherryPickToBase,
  TmpCherryPickOps,
} from "./git_worktree_service/cherry_pick.ts";
import {
  CreateWorktreeOps,
  createWorktree,
} from "./git_worktree_service/create.ts";
import {
  ApplyTrackedDiffOps,
  applyTrackedDiff,
} from "./git_worktree_service/inherit_dirty.ts";
import { isSafeRelativePath } from "./git_worktree_service/internal.ts";
import {
  executeTeardown,
  TeardownOps,
} from "./git_worktree_service/teardown.ts";
import {
  GitWorktreeService,
  GitWorktreeServiceLive,
  type WorktreeHandle,
  type WorktreeTeardownPlan,
} from "./git_worktree_service.ts";

// ---------------------------------------------------------------------------
// isSafeRelativePath — path validation for copyUntrackedFiles
// ---------------------------------------------------------------------------

describe("isSafeRelativePath", () => {
  const target = "/target/worktree";

  test("accepts ordinary relative paths", () => {
    expect(isSafeRelativePath("foo.txt", target)).toEqual(true);
    expect(isSafeRelativePath("dir/foo.txt", target)).toEqual(true);
    expect(isSafeRelativePath("dir/sub/foo.txt", target)).toEqual(true);
  });

  test("rejects empty string", () => {
    expect(isSafeRelativePath("", target)).toEqual(false);
  });

  test("rejects absolute paths", () => {
    expect(isSafeRelativePath("/etc/passwd", target)).toEqual(false);
  });

  test("rejects paths containing .. segments", () => {
    expect(isSafeRelativePath("../escape.txt", target)).toEqual(false);
    expect(isSafeRelativePath("dir/../../escape.txt", target)).toEqual(false);
    expect(isSafeRelativePath("..", target)).toEqual(false);
    expect(isSafeRelativePath("a/../b", target)).toEqual(false);
  });

  test("rejects paths that would resolve outside the target", () => {
    // Even if segments don't literally contain .., a .. anywhere is rejected
    expect(isSafeRelativePath("../../outside", target)).toEqual(false);
  });

  test("handles backslash-separated segments conservatively", () => {
    // On POSIX path.isAbsolute returns false for these and path.join/resolve
    // treats them as a single filename. The function still rejects obvious
    // traversal patterns on either separator.
    expect(isSafeRelativePath("..\\escape", target)).toEqual(false);
    expect(isSafeRelativePath("dir\\..\\escape", target)).toEqual(false);
  });
});

// ---------------------------------------------------------------------------
// copyUntrackedFiles — end-to-end against a real git repo
// ---------------------------------------------------------------------------

const liveLayer = Layer.mergeAll(
  FsServiceLive,
  ProcessServiceLive,
  GitWorktreeServiceLive.pipe(
    Layer.provide(Layer.mergeAll(FsServiceLive, ProcessServiceLive)),
  ),
);

async function withTempRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-wt-hardening-"));
  try {
    await $`git init ${dir}`.quiet();
    await $`git -C ${dir} config user.name nas-test`.quiet();
    await $`git -C ${dir} config user.email nas-test@example.com`.quiet();
    await $`git -C ${dir} config commit.gpgsign false`.quiet();
    await $`git -C ${dir} commit --allow-empty -m init`.quiet();
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("copyUntrackedFiles hardening", () => {
  test("untracked symlinks are copied as symlinks (not dereferenced)", async () => {
    await withTempRepo(async (repo) => {
      // Create a sensitive file outside the source worktree.
      const secretPath = path.join(repo, "secret.txt");
      await writeFile(secretPath, "SENSITIVE-HOST-CONTENT\n");

      // Attacker's untracked symlink in the base worktree pointing at the
      // sensitive file. ls-files --others would list it.
      const evilLink = path.join(repo, "evil");
      await symlink(secretPath, evilLink);

      // Commit secret so it doesn't show as untracked itself; only the
      // symlink is untracked. (The symlink is untracked because we never
      // `git add` it.)
      await $`git -C ${repo} add secret.txt`.quiet();
      await $`git -C ${repo} commit -m "add secret"`.quiet();

      // Create worktree via the service — this copies untracked files from
      // the dirty base worktree into the new worktree.
      const baseBranch = (
        await $`git -C ${repo} symbolic-ref --short HEAD`.text()
      ).trim();
      const branchName = `hardening-${Date.now()}`;
      const worktreePath = path.join(repo, ".nas", "worktrees", branchName);

      const effect = Effect.gen(function* () {
        const svc = yield* GitWorktreeService;
        const handle = yield* svc.createWorktree({
          repoRoot: repo,
          worktreePath,
          branchName,
          baseBranch,
        });
        return handle;
      }).pipe(Effect.provide(liveLayer));
      await Effect.runPromise(effect);

      // The `evil` entry in the new worktree must still be a symlink
      // pointing at the original target — NOT a regular file containing the
      // host secret.
      const copiedPath = path.join(worktreePath, "evil");
      const lst = await stat(copiedPath).catch(() => null);
      // lstat semantics via readlink: if readlink succeeds, it's a symlink.
      const linkTarget = await readlink(copiedPath);
      expect(linkTarget).toEqual(secretPath);
      // And it must not be a plain file whose contents leaked.
      expect(lst).not.toBeNull();

      // cleanup worktree
      await $`git -C ${repo} worktree remove --force ${worktreePath}`.quiet();
      await $`git -C ${repo} branch -D ${branchName}`.quiet();
    });
  });

  test("untracked paths with .. segments are rejected (not copied)", async () => {
    await withTempRepo(async (repo) => {
      // We simulate a malicious ls-files output by committing a safe file
      // and relying on the service to skip any relative path containing
      // "..". Since git itself won't normally emit "../escape" from
      // ls-files, we exercise the guard directly via isSafeRelativePath,
      // plus verify the end-to-end createWorktree still succeeds with a
      // benign untracked file.
      await writeFile(path.join(repo, "tracked.txt"), "base\n");
      await $`git -C ${repo} add tracked.txt`.quiet();
      await $`git -C ${repo} commit -m "tracked"`.quiet();
      await writeFile(path.join(repo, "harmless.txt"), "ok\n");

      const baseBranch = (
        await $`git -C ${repo} symbolic-ref --short HEAD`.text()
      ).trim();
      const branchName = `benign-${Date.now()}`;
      const worktreePath = path.join(repo, ".nas", "worktrees", branchName);

      const effect = Effect.gen(function* () {
        const svc = yield* GitWorktreeService;
        yield* svc.createWorktree({
          repoRoot: repo,
          worktreePath,
          branchName,
          baseBranch,
        });
      }).pipe(Effect.provide(liveLayer));
      await Effect.runPromise(effect);

      // Benign file was copied.
      const copied = await stat(path.join(worktreePath, "harmless.txt"));
      expect(copied.isFile()).toEqual(true);

      // Guard itself rejects escape paths.
      expect(isSafeRelativePath("../escape", worktreePath)).toEqual(false);
      expect(isSafeRelativePath("a/../../escape", worktreePath)).toEqual(false);

      await $`git -C ${repo} worktree remove --force ${worktreePath}`.quiet();
      await $`git -C ${repo} branch -D ${branchName}`.quiet();
    });
  });
});

// ---------------------------------------------------------------------------
// cherryPickInWorktree — branch coverage via fake CherryPickOps
// ---------------------------------------------------------------------------

interface FakeOpsConfig {
  readonly isDirty?: boolean;
  readonly stashPush?: boolean;
  readonly applyCherryPick?: boolean;
  readonly resolveEmpties?: boolean;
  readonly stashPop?: boolean;
}

function makeFakeCherryPickOps(
  config: FakeOpsConfig,
  shared?: string[],
): {
  layer: Layer.Layer<CherryPickOps>;
  calls: string[];
} {
  const calls = shared ?? [];
  const layer = Layer.succeed(CherryPickOps, {
    isDirty: (wt) =>
      Effect.sync(() => {
        calls.push(`isDirty(${wt})`);
        return config.isDirty ?? false;
      }),
    stashPush: (wt, _msg) =>
      Effect.sync(() => {
        calls.push(`stashPush(${wt})`);
        return config.stashPush ?? true;
      }),
    applyCherryPick: (wt, commits) =>
      Effect.sync(() => {
        calls.push(`applyCherryPick(${wt},[${commits.join(",")}])`);
        return config.applyCherryPick ?? true;
      }),
    resolveEmpties: (wt, expected) =>
      Effect.sync(() => {
        calls.push(`resolveEmpties(${wt},${expected})`);
        return config.resolveEmpties ?? false;
      }),
    cherryPickAbort: (wt) =>
      Effect.sync(() => {
        calls.push(`cherryPickAbort(${wt})`);
      }),
    stashPop: (wt) =>
      Effect.sync(() => {
        calls.push(`stashPop(${wt})`);
        return config.stashPop ?? true;
      }),
  });
  return { layer, calls };
}

async function runCherryPick(config: FakeOpsConfig): Promise<{
  result: boolean;
  calls: string[];
}> {
  const { layer, calls } = makeFakeCherryPickOps(config);
  const result = await Effect.runPromise(
    cherryPickInWorktree("/wt", ["abc", "def"], "branch").pipe(
      Effect.provide(layer),
    ),
  );
  return { result, calls };
}

describe("cherryPickInWorktree", () => {
  test("clean worktree + cherry-pick succeeds: returns true, no stash ops", async () => {
    const { result, calls } = await runCherryPick({
      isDirty: false,
      applyCherryPick: true,
    });
    expect(result).toEqual(true);
    expect(calls).toEqual(["isDirty(/wt)", "applyCherryPick(/wt,[abc,def])"]);
  });

  test("clean + cherry-pick fails but resolveEmpties rescues: returns true", async () => {
    const { result, calls } = await runCherryPick({
      isDirty: false,
      applyCherryPick: false,
      resolveEmpties: true,
    });
    expect(result).toEqual(true);
    expect(calls).toEqual([
      "isDirty(/wt)",
      "applyCherryPick(/wt,[abc,def])",
      "resolveEmpties(/wt,2)",
    ]);
  });

  test("clean + cherry-pick fails, cannot resolve: abort called, returns false", async () => {
    const { result, calls } = await runCherryPick({
      isDirty: false,
      applyCherryPick: false,
      resolveEmpties: false,
    });
    expect(result).toEqual(false);
    expect(calls).toEqual([
      "isDirty(/wt)",
      "applyCherryPick(/wt,[abc,def])",
      "resolveEmpties(/wt,2)",
      "cherryPickAbort(/wt)",
    ]);
  });

  test("dirty + stashPush fails: returns false, no cherry-pick attempt", async () => {
    const { result, calls } = await runCherryPick({
      isDirty: true,
      stashPush: false,
    });
    expect(result).toEqual(false);
    expect(calls).toEqual(["isDirty(/wt)", "stashPush(/wt)"]);
  });

  test("dirty + full happy path: stash, cherry-pick, pop", async () => {
    const { result, calls } = await runCherryPick({
      isDirty: true,
      stashPush: true,
      applyCherryPick: true,
      stashPop: true,
    });
    expect(result).toEqual(true);
    expect(calls).toEqual([
      "isDirty(/wt)",
      "stashPush(/wt)",
      "applyCherryPick(/wt,[abc,def])",
      "stashPop(/wt)",
    ]);
  });

  test("dirty + cherry-pick succeeds but stashPop fails: returns false", async () => {
    const { result, calls } = await runCherryPick({
      isDirty: true,
      stashPush: true,
      applyCherryPick: true,
      stashPop: false,
    });
    expect(result).toEqual(false);
    expect(calls).toEqual([
      "isDirty(/wt)",
      "stashPush(/wt)",
      "applyCherryPick(/wt,[abc,def])",
      "stashPop(/wt)",
    ]);
  });

  test("dirty + conflict + abort + stashPop succeeds: returns false", async () => {
    const { result, calls } = await runCherryPick({
      isDirty: true,
      stashPush: true,
      applyCherryPick: false,
      resolveEmpties: false,
      stashPop: true,
    });
    expect(result).toEqual(false);
    expect(calls).toEqual([
      "isDirty(/wt)",
      "stashPush(/wt)",
      "applyCherryPick(/wt,[abc,def])",
      "resolveEmpties(/wt,2)",
      "cherryPickAbort(/wt)",
      "stashPop(/wt)",
    ]);
  });

  test("dirty + conflict + abort + stashPop fails: returns false, warning logged", async () => {
    const { result, calls } = await runCherryPick({
      isDirty: true,
      stashPush: true,
      applyCherryPick: false,
      resolveEmpties: false,
      stashPop: false,
    });
    expect(result).toEqual(false);
    expect(calls).toEqual([
      "isDirty(/wt)",
      "stashPush(/wt)",
      "applyCherryPick(/wt,[abc,def])",
      "resolveEmpties(/wt,2)",
      "cherryPickAbort(/wt)",
      "stashPop(/wt)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// cherryPickInTmpWorktree — branch coverage via fake TmpCherryPickOps
// ---------------------------------------------------------------------------

interface FakeTmpOpsConfig {
  readonly applyCherryPick?: boolean;
  readonly resolveEmpties?: boolean;
}

function makeFakeTmpCherryPickOps(config: FakeTmpOpsConfig): {
  layer: Layer.Layer<TmpCherryPickOps>;
  calls: string[];
} {
  const calls: string[] = [];
  const layer = Layer.succeed(TmpCherryPickOps, {
    applyCherryPick: (wt, commits) =>
      Effect.sync(() => {
        calls.push(`applyCherryPick(${wt},[${commits.join(",")}])`);
        return config.applyCherryPick ?? true;
      }),
    resolveEmpties: (wt, expected) =>
      Effect.sync(() => {
        calls.push(`resolveEmpties(${wt},${expected})`);
        return config.resolveEmpties ?? false;
      }),
    cherryPickAbort: (wt) =>
      Effect.sync(() => {
        calls.push(`cherryPickAbort(${wt})`);
      }),
    updateBranchToWorktreeHead: (wt, repoRoot, targetBranch) =>
      Effect.sync(() => {
        calls.push(
          `updateBranchToWorktreeHead(${wt},${repoRoot},${targetBranch})`,
        );
      }),
  });
  return { layer, calls };
}

async function runTmpCherryPick(config: FakeTmpOpsConfig): Promise<{
  result: boolean;
  calls: string[];
}> {
  const { layer, calls } = makeFakeTmpCherryPickOps(config);
  const result = await Effect.runPromise(
    cherryPickInTmpWorktree("/tmp-wt", ["abc", "def"], "branch", "/repo").pipe(
      Effect.provide(layer),
    ),
  );
  return { result, calls };
}

describe("cherryPickInTmpWorktree", () => {
  test("cherry-pick succeeds: branch forwarded to new HEAD, returns true", async () => {
    const { result, calls } = await runTmpCherryPick({ applyCherryPick: true });
    expect(result).toEqual(true);
    expect(calls).toEqual([
      "applyCherryPick(/tmp-wt,[abc,def])",
      "updateBranchToWorktreeHead(/tmp-wt,/repo,branch)",
    ]);
  });

  test("cherry-pick fails, resolveEmpties rescues: branch forwarded, returns true", async () => {
    const { result, calls } = await runTmpCherryPick({
      applyCherryPick: false,
      resolveEmpties: true,
    });
    expect(result).toEqual(true);
    expect(calls).toEqual([
      "applyCherryPick(/tmp-wt,[abc,def])",
      "resolveEmpties(/tmp-wt,2)",
      "updateBranchToWorktreeHead(/tmp-wt,/repo,branch)",
    ]);
  });

  test("cherry-pick fails, cannot resolve: abort called, returns false", async () => {
    const { result, calls } = await runTmpCherryPick({
      applyCherryPick: false,
      resolveEmpties: false,
    });
    expect(result).toEqual(false);
    expect(calls).toEqual([
      "applyCherryPick(/tmp-wt,[abc,def])",
      "resolveEmpties(/tmp-wt,2)",
      "cherryPickAbort(/tmp-wt)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// applyTrackedDiff — branch coverage via fake ApplyTrackedDiffOps
// ---------------------------------------------------------------------------

interface FakeApplyTrackedDiffOpsConfig {
  readonly stagedPatch?: string;
  readonly unstagedPatch?: string;
}

function makeFakeApplyTrackedDiffOps(config: FakeApplyTrackedDiffOpsConfig): {
  layer: Layer.Layer<ApplyTrackedDiffOps>;
  calls: string[];
} {
  const calls: string[] = [];
  const layer = Layer.succeed(ApplyTrackedDiffOps, {
    readTrackedDiff: (src, { cached }) =>
      Effect.sync(() => {
        calls.push(`readTrackedDiff(${src},cached=${cached})`);
        return cached
          ? (config.stagedPatch ?? "")
          : (config.unstagedPatch ?? "");
      }),
    applyPatchToTarget: (target, patch, extraArgs) =>
      Effect.sync(() => {
        calls.push(
          `applyPatchToTarget(${target},len=${patch.length},[${extraArgs.join(",")}])`,
        );
      }),
  });
  return { layer, calls };
}

async function runApplyTrackedDiff(
  config: FakeApplyTrackedDiffOpsConfig,
): Promise<{ calls: string[] }> {
  const { layer, calls } = makeFakeApplyTrackedDiffOps(config);
  await Effect.runPromise(
    applyTrackedDiff("/src", "/target").pipe(Effect.provide(layer)),
  );
  return { calls };
}

describe("applyTrackedDiff", () => {
  test("both diffs empty: reads both, applies neither", async () => {
    const { calls } = await runApplyTrackedDiff({});
    expect(calls).toEqual([
      "readTrackedDiff(/src,cached=true)",
      "readTrackedDiff(/src,cached=false)",
    ]);
  });

  test("only staged non-empty: applies staged with --index, no unstaged apply", async () => {
    const { calls } = await runApplyTrackedDiff({ stagedPatch: "diff-a" });
    expect(calls).toEqual([
      "readTrackedDiff(/src,cached=true)",
      "applyPatchToTarget(/target,len=6,[--index])",
      "readTrackedDiff(/src,cached=false)",
    ]);
  });

  test("only unstaged non-empty: applies unstaged without --index", async () => {
    const { calls } = await runApplyTrackedDiff({ unstagedPatch: "diff-bc" });
    expect(calls).toEqual([
      "readTrackedDiff(/src,cached=true)",
      "readTrackedDiff(/src,cached=false)",
      "applyPatchToTarget(/target,len=7,[])",
    ]);
  });

  test("both diffs non-empty: applies staged then unstaged", async () => {
    const { calls } = await runApplyTrackedDiff({
      stagedPatch: "S",
      unstagedPatch: "UU",
    });
    expect(calls).toEqual([
      "readTrackedDiff(/src,cached=true)",
      "applyPatchToTarget(/target,len=1,[--index])",
      "readTrackedDiff(/src,cached=false)",
      "applyPatchToTarget(/target,len=2,[])",
    ]);
  });

  test("whitespace-only staged diff is treated as empty (not applied)", async () => {
    const { calls } = await runApplyTrackedDiff({
      stagedPatch: "   \n\t",
      unstagedPatch: "",
    });
    expect(calls).toEqual([
      "readTrackedDiff(/src,cached=true)",
      "readTrackedDiff(/src,cached=false)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// executeTeardown — branch coverage via fake TeardownOps
// ---------------------------------------------------------------------------

interface FakeTeardownOpsConfig {
  readonly cherryPickSuccess?: boolean;
  readonly removeOk?: boolean;
  readonly deleteOk?: boolean;
}

function makeFakeTeardownOps(
  config: FakeTeardownOpsConfig,
  shared?: string[],
): {
  layer: Layer.Layer<TeardownOps>;
  calls: string[];
} {
  const calls = shared ?? [];
  const layer = Layer.succeed(TeardownOps, {
    stashWorktreeChanges: (wt) =>
      Effect.sync(() => {
        calls.push(`stashWorktreeChanges(${wt})`);
      }),
    renameBranch: (branchName, repoRoot, newName) =>
      Effect.sync(() => {
        calls.push(`renameBranch(${branchName},${repoRoot},${newName})`);
      }),
    removeWorktree: (repoRoot, worktreePath) =>
      Effect.sync(() => {
        calls.push(`removeWorktree(${repoRoot},${worktreePath})`);
        return config.removeOk ?? true;
      }),
    deleteBranch: (repoRoot, branchName) =>
      Effect.sync(() => {
        calls.push(`deleteBranch(${repoRoot},${branchName})`);
        return config.deleteOk ?? true;
      }),
  });
  return { layer, calls };
}

/**
 * Stub layer that makes the real {@link cherryPickToBase} return a canned
 * boolean without spinning up nested fakes for every Op method. Tests that
 * only care that teardown sees a success/failure pivot use this instead of
 * wiring the full CherryPickToBaseOps + CherryPickOps stack.
 *
 * Implementation: if `success`, `listCommitsBetween` returns `""`, which
 * short-circuits `cherryPickToBase` to `true`. If not, the flow runs through
 * to `cherryPickInDetachedWorktree`, which returns `false`.
 */
function makeCherryPickToBaseStubLayers(
  success: boolean,
  shared: string[],
): Layer.Layer<CherryPickToBaseOps | CherryPickOps> {
  const cpToBase = Layer.succeed(CherryPickToBaseOps, {
    listCommitsBetween: (repoRoot, baseBranch, branchName) =>
      Effect.sync(() => {
        shared.push(
          `listCommitsBetween(${repoRoot},${baseBranch},${branchName})`,
        );
        return success ? "" : "aaa\n";
      }),
    resolveLocalBranch: (_repoRoot, ref) => Effect.succeed(ref),
    verifyRefExists: () => Effect.succeed(true),
    createBranch: () => Effect.void,
    findWorktreeForBranch: () => Effect.succeed(null),
    cherryPickInDetachedWorktree: (commitList, targetBranch, repoRoot) =>
      Effect.sync(() => {
        shared.push(
          `cherryPickInDetachedWorktree([${commitList.join(",")}],${targetBranch},${repoRoot})`,
        );
        return false;
      }),
  });
  // cherryPickToBase's R includes CherryPickOps (for the in-worktree path).
  // The stub never reaches that path, but Effect still needs the Tag satisfied.
  const cpOps = makeFakeCherryPickOps({}, shared).layer;
  return Layer.mergeAll(cpToBase, cpOps);
}

const fakeHandle: WorktreeHandle = {
  worktreePath: "/wt",
  branchName: "wt/foo",
  repoRoot: "/repo",
  baseBranch: "main",
  close: () => Effect.void,
};

async function runTeardown(
  plan: WorktreeTeardownPlan,
  config: FakeTeardownOpsConfig = {},
): Promise<{ calls: string[] }> {
  const calls: string[] = [];
  const { layer: teardownLayer } = makeFakeTeardownOps(config, calls);
  const cpStub = makeCherryPickToBaseStubLayers(
    config.cherryPickSuccess ?? true,
    calls,
  );
  await Effect.runPromise(
    executeTeardown(fakeHandle, plan).pipe(
      Effect.provide(Layer.mergeAll(teardownLayer, cpStub)),
    ),
  );
  return { calls };
}

describe("executeTeardown", () => {
  test("action=keep: no ops called", async () => {
    const { calls } = await runTeardown({ action: "keep" });
    expect(calls).toEqual([]);
  });

  test("dirtyAction=keep: bail out after (no) stash, worktree kept", async () => {
    const { calls } = await runTeardown({
      action: "delete",
      dirtyAction: "keep",
    });
    expect(calls).toEqual([]);
  });

  test("stash succeeds + cherry-pick success: remove + delete branch", async () => {
    const { calls } = await runTeardown(
      {
        action: "delete",
        dirtyAction: "stash",
        branchAction: "cherry-pick",
      },
      { cherryPickSuccess: true },
    );
    // cherryPickToBase short-circuits on empty listCommitsBetween; the stub's
    // single call stands in for "cherry-pick ran and succeeded".
    expect(calls).toEqual([
      "stashWorktreeChanges(/wt)",
      "listCommitsBetween(/repo,main,wt/foo)",
      "removeWorktree(/repo,/wt)",
      "deleteBranch(/repo,wt/foo)",
    ]);
  });

  test("branchAction=rename: rename branch, remove worktree, do NOT delete branch", async () => {
    const { calls } = await runTeardown({
      action: "delete",
      branchAction: "rename",
      newBranchName: "kept-branch",
    });
    expect(calls).toEqual([
      "renameBranch(wt/foo,/repo,kept-branch)",
      "removeWorktree(/repo,/wt)",
    ]);
  });

  test("branchAction=cherry-pick + failure: preserve branch (no delete)", async () => {
    const { calls } = await runTeardown(
      {
        action: "delete",
        branchAction: "cherry-pick",
      },
      { cherryPickSuccess: false },
    );
    // On failure the stub drives cherryPickToBase through the full detached
    // path; the trace is noisier but confirms real composition, not a
    // pre-wrapped `TeardownOps.cherryPickToBase` shim.
    expect(calls).toEqual([
      "listCommitsBetween(/repo,main,wt/foo)",
      "cherryPickInDetachedWorktree([aaa],main,/repo)",
      "removeWorktree(/repo,/wt)",
    ]);
  });

  test("no branchAction: defaults to delete; removeWorktree + deleteBranch called", async () => {
    const { calls } = await runTeardown({ action: "delete" });
    expect(calls).toEqual([
      "removeWorktree(/repo,/wt)",
      "deleteBranch(/repo,wt/foo)",
    ]);
  });

  test("removeWorktree fails: still attempts deleteBranch, no throw", async () => {
    const { calls } = await runTeardown(
      { action: "delete" },
      { removeOk: false },
    );
    expect(calls).toEqual([
      "removeWorktree(/repo,/wt)",
      "deleteBranch(/repo,wt/foo)",
    ]);
  });

  test("deleteBranch fails: logs error but does not throw", async () => {
    const { calls } = await runTeardown(
      { action: "delete" },
      { deleteOk: false },
    );
    expect(calls).toEqual([
      "removeWorktree(/repo,/wt)",
      "deleteBranch(/repo,wt/foo)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// cherryPickToBase — branch coverage via fake CherryPickToBaseOps
// ---------------------------------------------------------------------------

interface FakeCherryPickToBaseOpsConfig {
  readonly commitsRaw?: string;
  readonly resolvedBranch?: string;
  readonly refExists?: boolean;
  readonly checkedOutIn?: string | null;
  readonly detachedResult?: boolean;
  readonly failOn?:
    | "verifyRefExists"
    | "createBranch"
    | "findWorktreeForBranch";
}

function makeFakeCherryPickToBaseOps(
  config: FakeCherryPickToBaseOpsConfig,
  shared?: string[],
): {
  layer: Layer.Layer<CherryPickToBaseOps>;
  calls: string[];
} {
  const calls = shared ?? [];
  const layer = Layer.succeed(CherryPickToBaseOps, {
    listCommitsBetween: (repoRoot, baseBranch, branchName) =>
      Effect.sync(() => {
        calls.push(
          `listCommitsBetween(${repoRoot},${baseBranch},${branchName})`,
        );
        return config.commitsRaw ?? "";
      }),
    resolveLocalBranch: (repoRoot, ref) =>
      Effect.sync(() => {
        calls.push(`resolveLocalBranch(${repoRoot},${ref})`);
        return config.resolvedBranch ?? ref;
      }),
    verifyRefExists: (repoRoot, refName) =>
      Effect.gen(function* () {
        calls.push(`verifyRefExists(${repoRoot},${refName})`);
        if (config.failOn === "verifyRefExists") {
          return yield* Effect.die(new Error("verify boom"));
        }
        return config.refExists ?? true;
      }),
    createBranch: (repoRoot, branchName, fromRef) =>
      Effect.gen(function* () {
        calls.push(`createBranch(${repoRoot},${branchName},${fromRef})`);
        if (config.failOn === "createBranch") {
          return yield* Effect.die(new Error("create boom"));
        }
      }),
    findWorktreeForBranch: (repoRoot, branchName) =>
      Effect.gen(function* () {
        calls.push(`findWorktreeForBranch(${repoRoot},${branchName})`);
        if (config.failOn === "findWorktreeForBranch") {
          return yield* Effect.die(new Error("find boom"));
        }
        return config.checkedOutIn ?? null;
      }),
    cherryPickInDetachedWorktree: (commitList, targetBranch, repoRoot) =>
      Effect.sync(() => {
        calls.push(
          `cherryPickInDetachedWorktree([${commitList.join(",")}],${targetBranch},${repoRoot})`,
        );
        return config.detachedResult ?? true;
      }),
  });
  return { layer, calls };
}

async function runCherryPickToBase(
  config: FakeCherryPickToBaseOpsConfig & FakeOpsConfig,
): Promise<{ result: boolean; calls: string[] }> {
  const calls: string[] = [];
  const { layer: cpToBaseLayer } = makeFakeCherryPickToBaseOps(config, calls);
  // The in-worktree path calls CherryPickOps; the detached path does not.
  // Providing CherryPickOps unconditionally keeps the layer shape uniform.
  const { layer: cpOpsLayer } = makeFakeCherryPickOps(config, calls);
  const result = await Effect.runPromise(
    cherryPickToBase("wt/foo", "/repo", "main").pipe(
      Effect.provide(Layer.mergeAll(cpToBaseLayer, cpOpsLayer)),
    ),
  );
  return { result, calls };
}

describe("cherryPickToBase", () => {
  test("no commits to pick: returns true early", async () => {
    const { result, calls } = await runCherryPickToBase({ commitsRaw: "" });
    expect(result).toEqual(true);
    expect(calls).toEqual(["listCommitsBetween(/repo,main,wt/foo)"]);
  });

  test("whitespace-only commits output: also treated as empty", async () => {
    const { result, calls } = await runCherryPickToBase({
      commitsRaw: "  \n  \n",
    });
    expect(result).toEqual(true);
    expect(calls).toEqual(["listCommitsBetween(/repo,main,wt/foo)"]);
  });

  test("ref exists + worktree checked out: delegates to cherryPickInWorktree (CherryPickOps)", async () => {
    const { result, calls } = await runCherryPickToBase({
      commitsRaw: "aaa\nbbb\n",
      resolvedBranch: "main",
      refExists: true,
      checkedOutIn: "/repo/worktrees/main",
      // CherryPickOps defaults: isDirty=false, applyCherryPick=true
    });
    expect(result).toEqual(true);
    // cherryPickInWorktree runs on real CherryPickOps fake instead of a
    // pre-wrapped `cherryPickInCheckedOutWorktree` method.
    expect(calls).toEqual([
      "listCommitsBetween(/repo,main,wt/foo)",
      "resolveLocalBranch(/repo,main)",
      "verifyRefExists(/repo,refs/heads/main)",
      "findWorktreeForBranch(/repo,main)",
      "isDirty(/repo/worktrees/main)",
      "applyCherryPick(/repo/worktrees/main,[aaa,bbb])",
    ]);
  });

  test("ref missing: createBranch then falls through to detached path", async () => {
    const { result, calls } = await runCherryPickToBase({
      commitsRaw: "aaa\n",
      resolvedBranch: "main",
      refExists: false,
      checkedOutIn: null,
      detachedResult: true,
    });
    expect(result).toEqual(true);
    expect(calls).toEqual([
      "listCommitsBetween(/repo,main,wt/foo)",
      "resolveLocalBranch(/repo,main)",
      "verifyRefExists(/repo,refs/heads/main)",
      "createBranch(/repo,main,main)",
      "findWorktreeForBranch(/repo,main)",
      "cherryPickInDetachedWorktree([aaa],main,/repo)",
    ]);
  });

  test("ref exists + no worktree: delegates to detached variant", async () => {
    const { result, calls } = await runCherryPickToBase({
      commitsRaw: "aaa\n",
      resolvedBranch: "main",
      refExists: true,
      checkedOutIn: null,
      detachedResult: false,
    });
    expect(result).toEqual(false);
    expect(calls).toEqual([
      "listCommitsBetween(/repo,main,wt/foo)",
      "resolveLocalBranch(/repo,main)",
      "verifyRefExists(/repo,refs/heads/main)",
      "findWorktreeForBranch(/repo,main)",
      "cherryPickInDetachedWorktree([aaa],main,/repo)",
    ]);
  });

  test("setupExit defect (createBranch dies): Exit.Failure path returns false", async () => {
    const { result, calls } = await runCherryPickToBase({
      commitsRaw: "aaa\n",
      resolvedBranch: "main",
      refExists: false,
      failOn: "createBranch",
    });
    expect(result).toEqual(false);
    expect(calls).toEqual([
      "listCommitsBetween(/repo,main,wt/foo)",
      "resolveLocalBranch(/repo,main)",
      "verifyRefExists(/repo,refs/heads/main)",
      "createBranch(/repo,main,main)",
    ]);
  });

  test("resolveLocalBranch rewrites remote-style ref: targetBranch used for subsequent ops", async () => {
    const { result, calls } = await runCherryPickToBase({
      commitsRaw: "aaa\n",
      resolvedBranch: "develop",
      refExists: true,
      checkedOutIn: null,
      detachedResult: true,
    });
    expect(result).toEqual(true);
    // note: the resolved "develop" is threaded through verifyRefExists and
    // findWorktreeForBranch, not the original baseBranch "main".
    expect(calls).toEqual([
      "listCommitsBetween(/repo,main,wt/foo)",
      "resolveLocalBranch(/repo,main)",
      "verifyRefExists(/repo,refs/heads/develop)",
      "findWorktreeForBranch(/repo,develop)",
      "cherryPickInDetachedWorktree([aaa],develop,/repo)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// createWorktree — branch coverage via fake CreateWorktreeOps
// ---------------------------------------------------------------------------

interface FakeCreateWorktreeOpsConfig {
  readonly resolvedBranch?: string;
}

function makeFakeCreateWorktreeOps(
  config: FakeCreateWorktreeOpsConfig,
  shared?: string[],
): {
  layer: Layer.Layer<CreateWorktreeOps>;
  calls: string[];
} {
  const calls = shared ?? [];
  const layer = Layer.succeed(CreateWorktreeOps, {
    ensureNasGitignore: (repoRoot) =>
      Effect.sync(() => {
        calls.push(`ensureNasGitignore(${repoRoot})`);
      }),
    addWorktree: (repoRoot, branchName, worktreePath, baseBranch) =>
      Effect.sync(() => {
        calls.push(
          `addWorktree(${repoRoot},${branchName},${worktreePath},${baseBranch})`,
        );
      }),
    recordNasBase: (repoRoot, branchName, baseBranch) =>
      Effect.sync(() => {
        calls.push(`recordNasBase(${repoRoot},${branchName},${baseBranch})`);
      }),
    resolveLocalBranch: (repoRoot, ref) =>
      Effect.sync(() => {
        calls.push(`resolveLocalBranch(${repoRoot},${ref})`);
        return config.resolvedBranch ?? ref;
      }),
    inheritDirtyBaseWorktree: (repoRoot, localBaseBranch, targetWorktreePath) =>
      Effect.sync(() => {
        calls.push(
          `inheritDirtyBaseWorktree(${repoRoot},${localBaseBranch},${targetWorktreePath})`,
        );
      }),
    runOnCreateHook: (cwd, script) =>
      Effect.sync(() => {
        calls.push(`runOnCreateHook(${cwd},${script})`);
      }),
  });
  return { layer, calls };
}

/**
 * Minimum teardown-stack layer so `createWorktree` can complete without
 * spinning up real git. Callers that exercise `handle.close` can pass a
 * shared `calls` array to observe the composed teardown trace.
 */
function makeTeardownStackLayer(
  shared: string[],
): Layer.Layer<TeardownOps | CherryPickToBaseOps | CherryPickOps> {
  const teardown = makeFakeTeardownOps({}, shared).layer;
  // Short-circuit cherry-pick (listCommits→"") so `handle.close` with
  // branchAction=cherry-pick doesn't cascade through extra ops.
  const cpStub = makeCherryPickToBaseStubLayers(true, shared);
  return Layer.mergeAll(teardown, cpStub);
}

function buildCreateWorktreeLayers(
  config: FakeCreateWorktreeOpsConfig,
  shared: string[],
): Layer.Layer<
  CreateWorktreeOps | TeardownOps | CherryPickToBaseOps | CherryPickOps
> {
  const { layer: createLayer } = makeFakeCreateWorktreeOps(config, shared);
  return Layer.mergeAll(createLayer, makeTeardownStackLayer(shared));
}

describe("createWorktree", () => {
  test("happy path without onCreate hook: ops sequenced, no hook call", async () => {
    const calls: string[] = [];
    const layer = buildCreateWorktreeLayers({}, calls);
    const handle = await Effect.runPromise(
      createWorktree({
        repoRoot: "/repo",
        worktreePath: "/repo/.nas/worktrees/wt",
        branchName: "wt/foo",
        baseBranch: "main",
      }).pipe(Effect.provide(layer)),
    );
    expect(handle.worktreePath).toEqual("/repo/.nas/worktrees/wt");
    expect(handle.branchName).toEqual("wt/foo");
    expect(handle.repoRoot).toEqual("/repo");
    expect(handle.baseBranch).toEqual("main");
    expect(calls).toEqual([
      "ensureNasGitignore(/repo)",
      "addWorktree(/repo,wt/foo,/repo/.nas/worktrees/wt,main)",
      "recordNasBase(/repo,wt/foo,main)",
      "resolveLocalBranch(/repo,main)",
      "inheritDirtyBaseWorktree(/repo,main,/repo/.nas/worktrees/wt)",
    ]);
  });

  test("with onCreate hook: runOnCreateHook called after inherit", async () => {
    const calls: string[] = [];
    const layer = buildCreateWorktreeLayers({}, calls);
    await Effect.runPromise(
      createWorktree({
        repoRoot: "/repo",
        worktreePath: "/wt",
        branchName: "wt/foo",
        baseBranch: "main",
        onCreate: "echo hi",
      }).pipe(Effect.provide(layer)),
    );
    expect(calls).toEqual([
      "ensureNasGitignore(/repo)",
      "addWorktree(/repo,wt/foo,/wt,main)",
      "recordNasBase(/repo,wt/foo,main)",
      "resolveLocalBranch(/repo,main)",
      "inheritDirtyBaseWorktree(/repo,main,/wt)",
      "runOnCreateHook(/wt,echo hi)",
    ]);
  });

  test("remote-style baseBranch: resolveLocalBranch rewrite threads through inheritDirtyBaseWorktree", async () => {
    const calls: string[] = [];
    const layer = buildCreateWorktreeLayers({ resolvedBranch: "main" }, calls);
    await Effect.runPromise(
      createWorktree({
        repoRoot: "/repo",
        worktreePath: "/wt",
        branchName: "wt/foo",
        baseBranch: "origin/main",
      }).pipe(Effect.provide(layer)),
    );
    // Note: the resolved "main" (not "origin/main") is passed to
    // inheritDirtyBaseWorktree, but the original "origin/main" is retained
    // for addWorktree / recordNasBase since that's what git worktree add needs.
    expect(calls).toEqual([
      "ensureNasGitignore(/repo)",
      "addWorktree(/repo,wt/foo,/wt,origin/main)",
      "recordNasBase(/repo,wt/foo,origin/main)",
      "resolveLocalBranch(/repo,origin/main)",
      "inheritDirtyBaseWorktree(/repo,main,/wt)",
    ]);
  });

  test("returned handle.close runs executeTeardown through the captured Ops stack", async () => {
    const calls: string[] = [];
    const layer = buildCreateWorktreeLayers({}, calls);
    const handle = await Effect.runPromise(
      createWorktree({
        repoRoot: "/repo",
        worktreePath: "/wt",
        branchName: "wt/foo",
        baseBranch: "main",
      }).pipe(Effect.provide(layer)),
    );
    // `calls` at this point only contains createWorktree ops; reset to
    // isolate the teardown trace.
    calls.length = 0;
    await Effect.runPromise(handle.close({ action: "delete" }));
    // executeTeardown defaults to removeWorktree + deleteBranch when no
    // dirty/branch plan is supplied. Seeing these in the trace confirms the
    // captured TeardownOps context was wired through close().
    expect(calls).toEqual([
      "removeWorktree(/repo,/wt)",
      "deleteBranch(/repo,wt/foo)",
    ]);
  });
});
