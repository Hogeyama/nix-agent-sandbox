/**
 * GitWorktreeService — Effect-based abstraction over git worktree lifecycle.
 *
 * Encapsulates git worktree creation, querying, teardown, cherry-pick,
 * branch management, and dirty-state handling. Stages call intentful
 * methods instead of shelling out to git directly.
 *
 * Live implementation delegates to ProcessService and FsService.
 * Fake factory provides configurable stubs for testing.
 */

import { tmpdir } from "node:os";
import * as path from "node:path";
import { Context, Effect, Exit, Layer } from "effect";
import { logInfo } from "../../log.ts";
import type { FsService } from "../../services/fs.ts";
import { FsService as FsServiceTag } from "../../services/fs.ts";
import type { ProcessService } from "../../services/process.ts";
import { ProcessService as ProcessServiceTag } from "../../services/process.ts";

// ---------------------------------------------------------------------------
// Config & handle types
// ---------------------------------------------------------------------------

export interface CreateWorktreeParams {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly onCreate?: string;
}

export interface WorktreeTeardownPlan {
  readonly action: "keep" | "delete";
  readonly dirtyAction?: "stash" | "delete" | "keep";
  readonly branchAction?: "rename" | "cherry-pick" | "delete";
  readonly newBranchName?: string | null;
}

export interface WorktreeHandle {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly close: (plan: WorktreeTeardownPlan) => Effect.Effect<void>;
}

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
  readonly base: string | null;
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class GitWorktreeService extends Context.Tag("nas/GitWorktreeService")<
  GitWorktreeService,
  {
    /** Resolve the git repository root for a working directory. */
    readonly resolveRepository: (workDir: string) => Effect.Effect<string>;

    /** Resolve "HEAD" to actual branch name; validate that the base ref exists. */
    readonly resolveBaseBranch: (
      repoRoot: string,
      base: string,
    ) => Effect.Effect<string>;

    /** Find existing worktrees for a profile (names starting with "wt-"). */
    readonly findProfileWorktrees: (
      repoRoot: string,
      profileName: string,
    ) => Effect.Effect<WorktreeEntry[]>;

    /** Create a new worktree (add, config, inherit dirty state, onCreate hook). */
    readonly createWorktree: (
      params: CreateWorktreeParams,
    ) => Effect.Effect<WorktreeHandle>;

    /** Check if a worktree has uncommitted changes. */
    readonly isWorktreeDirty: (worktreePath: string) => Effect.Effect<boolean>;

    /** Get the HEAD commit hash of a worktree. */
    readonly getHead: (worktreePath: string) => Effect.Effect<string | null>;

    /** List oneline commits on branch not on baseBranch, up to limit. */
    readonly listBranchCommits: (opts: {
      repoRoot: string;
      branchName: string;
      baseBranch: string;
      limit: number;
    }) => Effect.Effect<string[]>;
  }
>() {}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Proc = Effect.Effect.Success<typeof ProcessServiceTag>;
type Fs = Effect.Effect.Success<typeof FsServiceTag>;

/** Run a git command, returning null on failure instead of throwing. */
function gitExec(
  proc: Proc,
  cmd: string[],
  opts?: { cwd?: string },
): Effect.Effect<string | null> {
  return proc.exec(cmd, opts).pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : null)),
  );
}

/** Extract a human-readable message from an Exit.Failure. */
function exitMessage(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return "";
  const cause = exit.cause;
  if (cause._tag === "Die") {
    const d = cause.defect;
    return d instanceof Error ? d.message : String(d);
  }
  if (cause._tag === "Fail") {
    const e = cause.error;
    return e instanceof Error ? e.message : String(e);
  }
  return "unknown error";
}

/**
 * Resolve remote ref (e.g. "origin/main") to local branch name.
 * If ref exists under refs/remotes/, strip the remote prefix.
 * Otherwise return as-is (already a local branch).
 */
function resolveLocalBranch(
  proc: Proc,
  repoRoot: string,
  ref: string,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const result = yield* gitExec(proc, [
      "git",
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/remotes/${ref}`,
    ]);
    if (result !== null) {
      const match = ref.match(/^[^/]+\/(.+)$/);
      return match ? match[1] : ref;
    }
    return ref;
  });
}

/** Ensure .nas/.gitignore exists with "*" content. */
function ensureNasGitignore(repoRoot: string, fs: Fs): Effect.Effect<void> {
  return Effect.gen(function* () {
    const gitignorePath = path.join(repoRoot, ".nas", ".gitignore");
    const fileExists = yield* fs.exists(gitignorePath);
    if (!fileExists) {
      yield* fs.mkdir(path.join(repoRoot, ".nas"), { recursive: true });
      yield* fs.writeFile(gitignorePath, "*\n");
    }
  });
}

/**
 * Inherit dirty changes from the base branch's worktree to the new worktree.
 * Applies staged diff, unstaged diff, and copies untracked files.
 */
function inheritDirtyBaseWorktree(
  proc: Proc,
  fs: Fs,
  repoRoot: string,
  localBaseBranch: string,
  targetWorktreePath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const sourceWorktreePath = yield* findWorktreeForBranch(
      proc,
      repoRoot,
      localBaseBranch,
    );
    if (!sourceWorktreePath || sourceWorktreePath === targetWorktreePath)
      return;

    const dirty = yield* checkDirty(proc, sourceWorktreePath);
    if (!dirty) return;

    logInfo(
      `[nas] Inheriting dirty changes from ${sourceWorktreePath} (${localBaseBranch})`,
    );

    yield* applyTrackedDiff(proc, fs, sourceWorktreePath, targetWorktreePath);
    yield* copyUntrackedFiles(proc, fs, sourceWorktreePath, targetWorktreePath);
  });
}

/** Check if a worktree is dirty via `git status --porcelain`. */
function checkDirty(proc: Proc, worktreePath: string): Effect.Effect<boolean> {
  return proc
    .exec(["git", "-C", worktreePath, "status", "--porcelain"])
    .pipe(Effect.map((out) => out.trim().length > 0));
}

/** Find the worktree path where a branch is checked out, or null. */
function findWorktreeForBranch(
  proc: Proc,
  repoRoot: string,
  branchName: string,
): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const output = yield* proc.exec([
      "git",
      "-C",
      repoRoot,
      "worktree",
      "list",
      "--porcelain",
    ]);
    const targetRef = `refs/heads/${branchName}`;
    let currentPath: string | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ") && currentPath) {
        if (line.slice("branch ".length) === targetRef) {
          return currentPath;
        }
      } else if (line === "") {
        currentPath = null;
      }
    }
    return null;
  });
}

/** Apply tracked diffs (staged + unstaged) from source to target worktree. */
function applyTrackedDiff(
  proc: Proc,
  fs: Fs,
  sourceWorktreePath: string,
  targetWorktreePath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stagedPatch = yield* proc.exec([
      "git",
      "-C",
      sourceWorktreePath,
      "diff",
      "--no-ext-diff",
      "--binary",
      "--cached",
    ]);
    if (stagedPatch.trim().length > 0) {
      yield* applyPatch(proc, fs, targetWorktreePath, stagedPatch, ["--index"]);
    }

    const unstagedPatch = yield* proc.exec([
      "git",
      "-C",
      sourceWorktreePath,
      "diff",
      "--no-ext-diff",
      "--binary",
    ]);
    if (unstagedPatch.trim().length > 0) {
      yield* applyPatch(proc, fs, targetWorktreePath, unstagedPatch);
    }
  });
}

/** Write a patch to a temp file and apply it. */
function applyPatch(
  proc: Proc,
  fs: Fs,
  targetWorktreePath: string,
  patch: string,
  extraArgs: string[] = [],
): Effect.Effect<void> {
  const acquire = Effect.gen(function* () {
    const tmpDirPath = yield* fs.mkdtemp(path.join(tmpdir(), "nas-worktree-"));
    return tmpDirPath;
  });
  const use = (tmpDir: string) =>
    Effect.gen(function* () {
      const patchFile = path.join(tmpDir, "patch.patch");
      const normalizedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
      yield* fs.writeFile(patchFile, normalizedPatch);
      console.log(
        `$ git -C ${targetWorktreePath} apply --binary --allow-empty ${extraArgs.join(" ")} ${patchFile}`,
      );
      yield* proc.exec([
        "git",
        "-C",
        targetWorktreePath,
        "apply",
        "--binary",
        "--allow-empty",
        ...extraArgs,
        patchFile,
      ]);
    });
  const release = (tmpDir: string) =>
    fs.rm(tmpDir, { recursive: true, force: true }).pipe(Effect.ignore);

  return Effect.acquireUseRelease(acquire, use, release);
}

/**
 * Validate that a git-reported relative path stays inside the target worktree.
 * Rejects absolute paths, paths containing ".." segments, and paths that
 * resolve outside `targetWorktreePath`. An attacker-controlled source
 * worktree could otherwise smuggle a path that escapes the target directory.
 */
export function isSafeRelativePath(
  relativePath: string,
  targetWorktreePath: string,
): boolean {
  if (relativePath.length === 0) return false;
  if (path.isAbsolute(relativePath)) return false;
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((s) => s === "..")) return false;
  const resolved = path.resolve(targetWorktreePath, relativePath);
  const rel = path.relative(targetWorktreePath, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

/** Copy untracked files from source to target worktree. */
function copyUntrackedFiles(
  proc: Proc,
  fs: Fs,
  sourceWorktreePath: string,
  targetWorktreePath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const output = yield* proc.exec([
      "git",
      "-C",
      sourceWorktreePath,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (output.length === 0) return;

    const untrackedFiles = output.split("\0").filter((f) => f.length > 0);
    for (const relativePath of untrackedFiles) {
      // The source worktree may be attacker-controlled (untrusted clone).
      // Reject any path that could escape the target directory.
      if (!isSafeRelativePath(relativePath, targetWorktreePath)) {
        console.error(`[nas] Skipping unsafe untracked path: ${relativePath}`);
        continue;
      }
      const sourcePath = path.join(sourceWorktreePath, relativePath);
      const targetPath = path.join(targetWorktreePath, relativePath);
      yield* fs.mkdir(path.dirname(targetPath), { recursive: true });
      // `cp -P` preserves symlinks as symlinks instead of dereferencing
      // them. This prevents an untracked `evil -> /etc/passwd` symlink in
      // the source worktree from exfiltrating host files into the new
      // worktree (where the agent container would read them).
      yield* proc.exec(["cp", "-P", "--", sourcePath, targetPath]);
    }
  });
}

// ---------------------------------------------------------------------------
// Teardown logic
// ---------------------------------------------------------------------------

function executeTeardown(
  proc: Proc,
  handle: WorktreeHandle,
  plan: WorktreeTeardownPlan,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (plan.action === "keep") {
      console.log(`[nas] Worktree kept: ${handle.worktreePath}`);
      return;
    }

    // Stash if requested
    if (plan.dirtyAction === "stash") {
      const stashResult = yield* stashWorktreeChanges(
        proc,
        handle.worktreePath,
      ).pipe(Effect.either);
      if (stashResult._tag === "Left") {
        console.error(`[nas] ${stashResult.left}`);
        console.log(`[nas] Worktree kept: ${handle.worktreePath}`);
        return;
      }
    }
    if (plan.dirtyAction === "keep") {
      console.log(`[nas] Worktree kept: ${handle.worktreePath}`);
      return;
    }

    // Handle branch action
    let shouldDeleteBranch = plan.branchAction !== "rename";

    if (plan.branchAction === "rename") {
      yield* renameBranch(
        proc,
        handle.branchName,
        handle.repoRoot,
        plan.newBranchName ?? null,
      );
    } else if (plan.branchAction === "cherry-pick") {
      const success = yield* cherryPickToBase(
        proc,
        handle.branchName,
        handle.repoRoot,
        handle.baseBranch,
      );
      if (!success) {
        shouldDeleteBranch = false;
        console.log(
          `[nas] Branch "${handle.branchName}" is preserved for manual resolution.`,
        );
      }
    }

    // Remove worktree
    console.log(`[nas] Removing worktree: ${handle.worktreePath}`);
    const removeResult = yield* gitExec(proc, [
      "git",
      "-C",
      handle.repoRoot,
      "worktree",
      "remove",
      "--force",
      handle.worktreePath,
    ]);
    if (removeResult === null) {
      console.error("[nas] Failed to remove worktree");
    }

    // Delete branch unless renamed or cherry-pick failed
    if (shouldDeleteBranch && handle.branchName) {
      const delResult = yield* gitExec(proc, [
        "git",
        "-C",
        handle.repoRoot,
        "branch",
        "-D",
        "--end-of-options",
        handle.branchName,
      ]);
      if (delResult !== null) {
        console.log(`[nas] Deleted branch: ${handle.branchName}`);
      } else {
        console.error(`[nas] Failed to delete branch: ${handle.branchName}`);
      }
    }
  });
}

function stashWorktreeChanges(
  proc: Proc,
  worktreePath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stashMessage = `nas teardown ${path.basename(worktreePath)} ${new Date().toISOString()}`;
    console.log(
      `$ git -C ${worktreePath} stash push --include-untracked -m ${stashMessage}`,
    );
    yield* proc.exec([
      "git",
      "-C",
      worktreePath,
      "stash",
      "push",
      "--include-untracked",
      "-m",
      stashMessage,
    ]);
    console.log(`[nas] Stashed worktree changes: ${stashMessage}`);
  });
}

function renameBranch(
  proc: Proc,
  branchName: string,
  repoRoot: string,
  newName: string | null,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!newName) {
      console.log("[nas] No name entered, keeping original branch name.");
      return;
    }
    const result = yield* gitExec(proc, [
      "git",
      "-C",
      repoRoot,
      "branch",
      "-m",
      "--end-of-options",
      branchName,
      newName,
    ]);
    if (result !== null) {
      console.log(`[nas] Renamed branch: ${branchName} → ${newName}`);
    } else {
      console.error(`[nas] Failed to rename branch: ${branchName}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Cherry-pick
// ---------------------------------------------------------------------------

function cherryPickToBase(
  proc: Proc,
  branchName: string,
  repoRoot: string,
  baseBranch: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const commitsRaw = (yield* proc.exec([
      "git",
      "-C",
      repoRoot,
      "log",
      "--format=%H",
      "--reverse",
      "--end-of-options",
      `${baseBranch}..${branchName}`,
    ])).trim();

    if (!commitsRaw) {
      console.log("[nas] No commits to cherry-pick.");
      return true;
    }

    const commitList = commitsRaw.split("\n");
    console.log(
      `[nas] Cherry-picking ${commitList.length} commit(s) onto ${baseBranch}...`,
    );

    const targetBranch = yield* resolveLocalBranch(proc, repoRoot, baseBranch);

    const setupExit = yield* Effect.gen(function* () {
      const verifyResult = yield* gitExec(proc, [
        "git",
        "-C",
        repoRoot,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `refs/heads/${targetBranch}`,
      ]);
      if (verifyResult === null) {
        console.log(
          `[nas] Creating local branch "${targetBranch}" from ${baseBranch}`,
        );
        console.log(
          `$ git -C ${repoRoot} branch ${targetBranch} ${baseBranch}`,
        );
        yield* proc.exec([
          "git",
          "-C",
          repoRoot,
          "branch",
          "--end-of-options",
          targetBranch,
          baseBranch,
        ]);
      }

      const checkedOutIn = yield* findWorktreeForBranch(
        proc,
        repoRoot,
        targetBranch,
      );

      if (checkedOutIn) {
        return yield* cherryPickInWorktree(
          proc,
          checkedOutIn,
          commitList,
          targetBranch,
        );
      }

      return yield* cherryPickDetached(
        proc,
        commitList,
        targetBranch,
        repoRoot,
      );
    }).pipe(Effect.exit);

    if (Exit.isFailure(setupExit)) {
      console.error(
        `[nas] Cherry-pick setup failed: ${exitMessage(setupExit)}`,
      );
      return false;
    }
    return setupExit.value;
  });
}

function cherryPickInWorktree(
  proc: Proc,
  worktreePath: string,
  commitList: string[],
  targetBranch: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const dirty = yield* checkDirty(proc, worktreePath);
    let stashed = false;
    const stashMessage = `nas cherry-pick ${targetBranch} ${new Date().toISOString()}`;

    if (dirty) {
      console.log(
        `[nas] Worktree for "${targetBranch}" has uncommitted changes; stashing temporarily before cherry-pick.`,
      );
      const stashOk = yield* gitExec(proc, [
        "git",
        "-C",
        worktreePath,
        "stash",
        "push",
        "--include-untracked",
        "-m",
        stashMessage,
      ]);
      if (stashOk === null) {
        console.error(
          `[nas] Failed to stash changes in "${targetBranch}" worktree`,
        );
        console.error(`[nas]   ${worktreePath}`);
        return false;
      }
      stashed = true;
    }

    console.log(`[nas] Cherry-picking in worktree: ${worktreePath}`);
    const cpOk = yield* gitExec(proc, [
      "git",
      "-C",
      worktreePath,
      "cherry-pick",
      "--end-of-options",
      ...commitList,
    ]);
    let success = cpOk !== null;

    if (!success) {
      console.error("[nas] cherry-pick exited with error");
      const resolved = yield* resolveEmptyCherryPicks(
        proc,
        worktreePath,
        commitList.length,
      );
      if (resolved) {
        success = true;
      } else {
        console.error("[nas] Cherry-pick failed with conflicts.");
        yield* gitExec(proc, [
          "git",
          "-C",
          worktreePath,
          "cherry-pick",
          "--abort",
        ]);
      }
    }

    if (!success && stashed) {
      const popOk = yield* gitExec(proc, [
        "git",
        "-C",
        worktreePath,
        "stash",
        "pop",
      ]);
      if (popOk === null) {
        console.error(
          `[nas] Failed to restore stashed changes in "${targetBranch}" worktree`,
        );
      }
      return false;
    }
    if (!success) return false;

    if (stashed) {
      const popOk = yield* gitExec(proc, [
        "git",
        "-C",
        worktreePath,
        "stash",
        "pop",
      ]);
      if (popOk === null) {
        console.error(
          `[nas] Cherry-pick succeeded, but restoring stashed changes failed`,
        );
        return false;
      }
    }

    console.log("[nas] Cherry-pick completed successfully.");
    return true;
  });
}

function cherryPickDetached(
  proc: Proc,
  commitList: string[],
  targetBranch: string,
  repoRoot: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const targetRef = (yield* proc.exec([
      "git",
      "-C",
      repoRoot,
      "rev-parse",
      "--end-of-options",
      `refs/heads/${targetBranch}`,
    ])).trim();
    const tmpWorktree = path.join(
      repoRoot,
      ".nas",
      "worktrees",
      `nas-cherry-pick-tmp-${Date.now()}`,
    );
    console.log(
      `$ git -C ${repoRoot} worktree add --detach ${tmpWorktree} ${targetRef}`,
    );
    yield* proc.exec([
      "git",
      "-C",
      repoRoot,
      "worktree",
      "add",
      "--detach",
      "--end-of-options",
      tmpWorktree,
      targetRef,
    ]);

    const result = yield* Effect.acquireUseRelease(
      Effect.succeed(tmpWorktree),
      (tw) =>
        cherryPickInTmpWorktree(proc, tw, commitList, targetBranch, repoRoot),
      (tw) =>
        gitExec(proc, [
          "git",
          "-C",
          repoRoot,
          "worktree",
          "remove",
          "--force",
          tw,
        ]).pipe(Effect.ignore),
    );

    return result;
  });
}

function cherryPickInTmpWorktree(
  proc: Proc,
  tmpWorktree: string,
  commitList: string[],
  targetBranch: string,
  repoRoot: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    console.log(`$ git -C ${tmpWorktree} cherry-pick ${commitList.join(" ")}`);
    const cpOk = yield* gitExec(proc, [
      "git",
      "-C",
      tmpWorktree,
      "cherry-pick",
      "--end-of-options",
      ...commitList,
    ]);

    if (cpOk !== null) {
      const newHead = (yield* proc.exec([
        "git",
        "-C",
        tmpWorktree,
        "rev-parse",
        "HEAD",
      ])).trim();
      console.log(`$ git -C ${repoRoot} branch -f ${targetBranch} ${newHead}`);
      yield* proc.exec([
        "git",
        "-C",
        repoRoot,
        "branch",
        "-f",
        "--end-of-options",
        targetBranch,
        newHead,
      ]);
      console.log("[nas] Cherry-pick completed successfully.");
      return true;
    }

    console.error("[nas] cherry-pick exited with error");
    const resolved = yield* resolveEmptyCherryPicks(
      proc,
      tmpWorktree,
      commitList.length,
    );
    if (resolved) {
      const newHead = (yield* proc.exec([
        "git",
        "-C",
        tmpWorktree,
        "rev-parse",
        "HEAD",
      ])).trim();
      console.log(`$ git -C ${repoRoot} branch -f ${targetBranch} ${newHead}`);
      yield* proc.exec([
        "git",
        "-C",
        repoRoot,
        "branch",
        "-f",
        "--end-of-options",
        targetBranch,
        newHead,
      ]);
      return true;
    }

    console.error("[nas] Cherry-pick failed with conflicts.");
    yield* gitExec(proc, ["git", "-C", tmpWorktree, "cherry-pick", "--abort"]);
    return false;
  });
}

function resolveEmptyCherryPicks(
  proc: Proc,
  worktree: string,
  maxAttempts: number,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (let i = 0; i < maxAttempts; i++) {
      const cpHead = yield* gitExec(proc, [
        "git",
        "-C",
        worktree,
        "rev-parse",
        "CHERRY_PICK_HEAD",
      ]);
      if (cpHead === null) {
        console.log("[nas] Cherry-pick completed (empty commits skipped).");
        return true;
      }

      const status = (yield* proc.exec([
        "git",
        "-C",
        worktree,
        "status",
        "--porcelain",
      ])).trim();
      if (status === "") {
        console.log("[nas] Skipping empty cherry-pick (already applied).");
        yield* gitExec(proc, ["git", "-C", worktree, "cherry-pick", "--skip"]);
      } else {
        return false;
      }
    }

    const finalCheck = yield* gitExec(proc, [
      "git",
      "-C",
      worktree,
      "rev-parse",
      "CHERRY_PICK_HEAD",
    ]);
    if (finalCheck === null) {
      console.log("[nas] Cherry-pick completed (empty commits skipped).");
      return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Worktree list parsing (shared with findProfileWorktrees)
// ---------------------------------------------------------------------------

interface RawWorktreeEntry {
  path: string;
  head: string;
  branch: string;
}

function parseWorktreeList(output: string): RawWorktreeEntry[] {
  const entries: RawWorktreeEntry[] = [];
  let current: Partial<RawWorktreeEntry> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "" && current.path) {
      entries.push({
        path: current.path,
        head: current.head ?? "",
        branch: current.branch ?? "",
      });
      current = {};
    }
  }
  // last entry (git worktree list doesn't always end with blank line)
  if (current.path) {
    entries.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? "",
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const GitWorktreeServiceLive: Layer.Layer<
  GitWorktreeService,
  never,
  ProcessService | FsService
> = Layer.effect(
  GitWorktreeService,
  Effect.gen(function* () {
    const proc = yield* ProcessServiceTag;
    const fs = yield* FsServiceTag;

    return GitWorktreeService.of({
      resolveRepository: (workDir) =>
        Effect.gen(function* () {
          // --show-toplevel は worktree 内ではそのパスを返すため、
          // --git-common-dir の親ディレクトリで本体リポジトリルートを取得する
          const toplevel = yield* gitExec(proc, [
            "git",
            "-C",
            workDir,
            "rev-parse",
            "--show-toplevel",
          ]);
          if (toplevel === null) {
            return yield* Effect.fail(
              new Error(
                `"${workDir}" is not inside a git repository. Worktree requires a git repo.`,
              ),
            );
          }

          const commonDir = yield* gitExec(proc, [
            "git",
            "-C",
            workDir,
            "rev-parse",
            "--git-common-dir",
          ]);
          if (commonDir !== null) {
            const absCommonDir = path.resolve(workDir, commonDir.trim());
            const mainRoot = path.dirname(absCommonDir);
            if (mainRoot !== toplevel.trim()) {
              logInfo(
                `[nas] Detected git worktree; using main repository root: ${mainRoot}`,
              );
              return mainRoot;
            }
          }

          return toplevel.trim();
        }).pipe(Effect.orDie),

      resolveBaseBranch: (repoRoot, base) =>
        Effect.gen(function* () {
          // Resolve "HEAD" to current branch name
          let resolved = base;
          if (base === "HEAD") {
            const branch = yield* gitExec(proc, [
              "git",
              "-C",
              repoRoot,
              "symbolic-ref",
              "--short",
              "HEAD",
            ]);
            if (branch === null) {
              return yield* Effect.fail(
                new Error(
                  'worktree.base is "HEAD" but the repository is in detached HEAD state.',
                ),
              );
            }
            resolved = branch.trim();
            console.log(`[nas] Resolved HEAD to current branch: ${resolved}`);
          }

          // Validate the base ref exists
          const valid = yield* gitExec(proc, [
            "git",
            "-C",
            repoRoot,
            "rev-parse",
            "--verify",
            "--end-of-options",
            resolved,
          ]);
          if (valid === null) {
            return yield* Effect.fail(
              new Error(
                `Base ref "${resolved}" not found. Run "git fetch" to update remote refs.`,
              ),
            );
          }

          return resolved;
        }).pipe(Effect.orDie),

      findProfileWorktrees: (repoRoot, _profileName) =>
        Effect.gen(function* () {
          const output = yield* proc.exec([
            "git",
            "-C",
            repoRoot,
            "worktree",
            "list",
            "--porcelain",
          ]);

          const raw = parseWorktreeList(output);
          // Filter to worktrees under .nas/worktrees/ directory
          const nasWorktreeDir = path.join(repoRoot, ".nas", "worktrees");
          const nasEntries = raw.filter(
            (e) =>
              e.path.startsWith(nasWorktreeDir + path.sep) &&
              path.basename(e.path).startsWith("nas-"),
          );

          // Read nasBase config for each branch
          const entries: WorktreeEntry[] = [];
          for (const entry of nasEntries) {
            let base: string | null = null;
            if (entry.branch) {
              const branchName = entry.branch.replace("refs/heads/", "");
              const value = yield* gitExec(proc, [
                "git",
                "-C",
                repoRoot,
                "config",
                "--get",
                `branch.${branchName}.nasBase`,
              ]);
              if (value !== null) {
                const trimmed = value.trim();
                base = trimmed.length > 0 ? trimmed : null;
              }
            }
            entries.push({ ...entry, base });
          }

          return entries;
        }),

      createWorktree: (params) =>
        Effect.gen(function* () {
          yield* ensureNasGitignore(params.repoRoot, fs);

          logInfo(
            `[nas] Creating worktree: ${params.worktreePath} (branch: ${params.branchName}) from ${params.baseBranch}`,
          );
          console.log(
            `$ git -C ${params.repoRoot} worktree add -b ${params.branchName} ${params.worktreePath} ${params.baseBranch}`,
          );
          yield* proc.exec([
            "git",
            "-C",
            params.repoRoot,
            "worktree",
            "add",
            "-b",
            params.branchName,
            "--end-of-options",
            params.worktreePath,
            params.baseBranch,
          ]);

          // Record base ref in branch config for `nas worktree list`
          yield* proc.exec([
            "git",
            "-C",
            params.repoRoot,
            "config",
            `branch.${params.branchName}.nasBase`,
            params.baseBranch,
          ]);

          const localBaseBranch = yield* resolveLocalBranch(
            proc,
            params.repoRoot,
            params.baseBranch,
          );
          yield* inheritDirtyBaseWorktree(
            proc,
            fs,
            params.repoRoot,
            localBaseBranch,
            params.worktreePath,
          );

          if (params.onCreate) {
            logInfo(`[nas] Running on-create hook: ${params.onCreate}`);
            console.log(
              `$ bash -c ${params.onCreate} (cwd: ${params.worktreePath})`,
            );
            yield* proc.exec(["bash", "-c", params.onCreate], {
              cwd: params.worktreePath,
            });
          }

          const handle: WorktreeHandle = {
            worktreePath: params.worktreePath,
            branchName: params.branchName,
            repoRoot: params.repoRoot,
            baseBranch: params.baseBranch,
            close: (plan) => executeTeardown(proc, handle, plan),
          };

          return handle;
        }),

      isWorktreeDirty: (worktreePath) => checkDirty(proc, worktreePath),

      getHead: (worktreePath) =>
        gitExec(proc, ["git", "-C", worktreePath, "rev-parse", "HEAD"]).pipe(
          Effect.map((h) => (h !== null ? h.trim() : null)),
        ),

      listBranchCommits: (opts) =>
        Effect.gen(function* () {
          const gitDir = ["-C", opts.repoRoot];
          const result = yield* gitExec(proc, [
            "git",
            ...gitDir,
            "log",
            "--oneline",
            `-${opts.limit}`,
            "--end-of-options",
            `${opts.baseBranch}..${opts.branchName}`,
          ]);
          if (result === null || result.trim() === "") return [];
          return result.trim().split("\n");
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface GitWorktreeServiceFakeConfig {
  readonly resolveRepository?: (workDir: string) => Effect.Effect<string>;
  readonly resolveBaseBranch?: (
    repoRoot: string,
    base: string,
  ) => Effect.Effect<string>;
  readonly findProfileWorktrees?: (
    repoRoot: string,
    profileName: string,
  ) => Effect.Effect<WorktreeEntry[]>;
  readonly createWorktree?: (
    params: CreateWorktreeParams,
  ) => Effect.Effect<WorktreeHandle>;
  readonly isWorktreeDirty?: (worktreePath: string) => Effect.Effect<boolean>;
  readonly getHead?: (worktreePath: string) => Effect.Effect<string | null>;
  readonly listBranchCommits?: (opts: {
    repoRoot: string;
    branchName: string;
    baseBranch: string;
    limit: number;
  }) => Effect.Effect<string[]>;
}

export function makeGitWorktreeServiceFake(
  overrides: GitWorktreeServiceFakeConfig = {},
): Layer.Layer<GitWorktreeService> {
  const defaultHandle: WorktreeHandle = {
    worktreePath: "/tmp/fake-worktree",
    branchName: "wt/fake",
    repoRoot: "/tmp/fake-repo",
    baseBranch: "main",
    close: () => Effect.void,
  };

  return Layer.succeed(
    GitWorktreeService,
    GitWorktreeService.of({
      resolveRepository:
        overrides.resolveRepository ?? ((workDir) => Effect.succeed(workDir)),
      resolveBaseBranch:
        overrides.resolveBaseBranch ??
        ((_repoRoot, base) => Effect.succeed(base)),
      findProfileWorktrees:
        overrides.findProfileWorktrees ?? (() => Effect.succeed([])),
      createWorktree:
        overrides.createWorktree ?? (() => Effect.succeed(defaultHandle)),
      isWorktreeDirty:
        overrides.isWorktreeDirty ?? (() => Effect.succeed(false)),
      getHead: overrides.getHead ?? (() => Effect.succeed(null)),
      listBranchCommits:
        overrides.listBranchCommits ?? (() => Effect.succeed([])),
    }),
  );
}
