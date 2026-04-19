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
  GitWorktreeService,
  GitWorktreeServiceLive,
  isSafeRelativePath,
} from "./git_worktree.ts";

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
