import { expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
        missingCommonDirFiles: [path.join(root, ".git/commondir")],
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
        path.join(root, ".git/worktrees/w1/commondir"),
      ]);
      expect(probe?.missingHookDirs).toEqual([path.join(root, ".git/hooks")]);
      expect(probe?.missingCommonDirFiles).toEqual([
        path.join(root, ".git/commondir"),
      ]);

      // 他の worktree の commondir も、その worktree で host の git が読むので
      // 元の checkout からの probe で保護する。
      const fromMain = await resolveGitMetadata(root);
      expect(fromMain?.readOnlyPaths).toContain(
        path.join(root, ".git/worktrees/w1/commondir"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * git は linked worktree に限らずどの gitdir でも `commondir` を読み、そこを
 * common dir として config と hooks を読む。nas が作る `.` の placeholder が
 * 無害であることと、placeholder が無ければ本当に迂回できることを実物の git で
 * 確かめる。後者が通らなくなったら (git が plain repo で commondir を読まなく
 * なったら) この保護は不要になる。
 */
test.skipIf(!gitAvailable)(
  "git honors commondir in a plain repo; the '.' placeholder behaves as if absent",
  async () => {
    const root = await makeRepo();
    const evil = `${root}-evil`;
    try {
      const probe = await resolveGitMetadata(root);
      const [commondir] = probe?.missingCommonDirFiles ?? [];
      expect(commondir).toBe(path.join(root, ".git/commondir"));

      await cp(path.join(root, ".git"), evil, { recursive: true });
      git(evil, "config", "--file", "config", "core.fsmonitor", "exit 1");
      git(evil, "config", "--file", "config", "nas.marker", "redirected");
      await writeFile(commondir, `${evil}\n`);
      const redirected = Bun.spawnSync(
        ["git", "-C", root, "config", "nas.marker"],
        { env: GIT_ENV },
      );
      expect(redirected.stdout.toString().trim()).toBe("redirected");

      await writeFile(commondir, ".\n");
      git(root, "config", "nas.marker", "own");
      git(root, "status", "--short");
      git(root, "commit", "-q", "--allow-empty", "-m", "second");
      git(root, "worktree", "add", "-q", path.join(root, "wt"));
      const own = Bun.spawnSync(["git", "-C", root, "config", "nas.marker"], {
        env: GIT_ENV,
      });
      expect(own.stdout.toString().trim()).toBe("own");
      const common = Bun.spawnSync(
        ["git", "-C", root, "rev-parse", "--git-common-dir"],
        { env: GIT_ENV },
      );
      expect(path.resolve(root, common.stdout.toString().trim())).toBe(
        path.join(root, ".git"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(evil, { recursive: true, force: true });
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
