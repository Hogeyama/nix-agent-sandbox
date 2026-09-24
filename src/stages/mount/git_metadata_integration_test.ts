import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGitMetadata } from "./mount_probes.ts";

function hasGit(): boolean {
  try {
    return Bun.spawnSync(["git", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

const gitAvailable = hasGit();

// Isolate from the user's global config (hooksPath, templates, etc.).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
}

async function makeRepo(): Promise<string> {
  // realpath: git reports physical paths, so compare against them
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "nas-git-metadata-")),
  );
  git(root, "init", "-q", "--template=", ".");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

test("resolveGitMetadata: outside a repository returns null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-git-metadata-none-"));
  try {
    expect(await resolveGitMetadata(dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!gitAvailable)(
  "resolveGitMetadata: main checkout reports config and a missing hooks dir",
  async () => {
    const root = await makeRepo();
    try {
      const probe = await resolveGitMetadata(root);
      expect(probe).toEqual({
        readOnlyPaths: [path.join(root, ".git/config")],
        missingHookDirs: [path.join(root, ".git/hooks")],
        skippedSymlinks: [],
      });

      await mkdir(path.join(root, ".git/hooks"));
      expect((await resolveGitMetadata(root))?.readOnlyPaths).toEqual([
        path.join(root, ".git/config"),
        path.join(root, ".git/hooks"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!gitAvailable)(
  "resolveGitMetadata: relative core.hooksPath resolves against the worktree top, even from a subdir",
  async () => {
    const root = await makeRepo();
    try {
      git(root, "config", "core.hooksPath", ".husky");
      await mkdir(path.join(root, ".husky"));
      await mkdir(path.join(root, "sub"));
      const probe = await resolveGitMetadata(path.join(root, "sub"));
      expect(probe?.readOnlyPaths).toContain(path.join(root, ".husky"));
      expect(probe?.missingHookDirs).toEqual([path.join(root, ".git/hooks")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!gitAvailable)(
  "resolveGitMetadata: linked worktree uses the common dir and protects its .git file",
  async () => {
    const root = await makeRepo();
    try {
      const worktree = path.join(root, ".nas/worktrees/w1");
      git(root, "worktree", "add", "-q", worktree);
      const probe = await resolveGitMetadata(worktree);
      expect(probe?.readOnlyPaths).toEqual([
        path.join(worktree, ".git"),
        path.join(root, ".git/config"),
      ]);
      expect(probe?.missingHookDirs).toEqual([path.join(root, ".git/hooks")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!gitAvailable)(
  "resolveGitMetadata: symlinked hooks dir is reported, not protected",
  async () => {
    const root = await makeRepo();
    try {
      await mkdir(path.join(root, "githooks"));
      await symlink("../githooks", path.join(root, ".git/hooks"));
      const probe = await resolveGitMetadata(root);
      expect(probe?.skippedSymlinks).toEqual([path.join(root, ".git/hooks")]);
      expect(probe?.missingHookDirs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
