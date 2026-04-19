/**
 * Module-internal D1 helpers shared by the layered git_worktree_service
 * pieces. Each function is a thin wrapper over a single git / fs primitive
 * (or a pure parser / validator). They are not exposed through the public
 * service barrel — callers are sibling files inside `git_worktree_service/`.
 */

import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Exit } from "effect";
import { logInfo } from "../../../log.ts";
import type { FsService } from "../../../services/fs.ts";
import { FsService as FsServiceTag } from "../../../services/fs.ts";
import type { ProcessService } from "../../../services/process.ts";
import { ProcessService as ProcessServiceTag } from "../../../services/process.ts";

export type Proc = Effect.Effect.Success<typeof ProcessServiceTag>;
export type Fs = Effect.Effect.Success<typeof FsServiceTag>;

// Re-export the service types so sibling files can refer to them through the
// stage-local module rather than reaching back into src/services.
export type { FsService, ProcessService };
export { FsServiceTag, ProcessServiceTag };

/** Run a git command, returning null on failure instead of throwing. */
export function gitExec(
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
export function exitMessage(exit: Exit.Exit<unknown, unknown>): string {
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
export function resolveLocalBranch(
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
export function ensureNasGitignore(
  repoRoot: string,
  fs: Fs,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const gitignorePath = path.join(repoRoot, ".nas", ".gitignore");
    const fileExists = yield* fs.exists(gitignorePath);
    if (!fileExists) {
      yield* fs.mkdir(path.join(repoRoot, ".nas"), { recursive: true });
      yield* fs.writeFile(gitignorePath, "*\n");
    }
  });
}

/** Check if a worktree is dirty via `git status --porcelain`. */
export function checkDirty(
  proc: Proc,
  worktreePath: string,
): Effect.Effect<boolean> {
  return proc
    .exec(["git", "-C", worktreePath, "status", "--porcelain"])
    .pipe(Effect.map((out) => out.trim().length > 0));
}

/** Find the worktree path where a branch is checked out, or null. */
export function findWorktreeForBranch(
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

/** Write a patch to a temp file and apply it. */
export function applyPatch(
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
      logInfo(
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

export function resolveEmptyCherryPicks(
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
        logInfo("[nas] Cherry-pick completed (empty commits skipped).");
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
        logInfo("[nas] Skipping empty cherry-pick (already applied).");
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
      logInfo("[nas] Cherry-pick completed (empty commits skipped).");
      return true;
    }
    return false;
  });
}

interface RawWorktreeEntry {
  path: string;
  head: string;
  branch: string;
}

export function parseWorktreeList(output: string): RawWorktreeEntry[] {
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
