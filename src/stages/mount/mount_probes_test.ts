import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ensureDevcontainerClaudeState,
  resolveDevcontainerGitMetadata,
} from "./mount_probes.ts";

async function git(args: string[]) {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
}
test("external linked worktree resolves only its shared Git metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-ide-git-"));
  try {
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "external");
    await git(["init", repo]);
    await git([
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    await git(["-C", repo, "worktree", "add", "-b", "linked", worktree]);
    expect(await resolveDevcontainerGitMetadata(worktree)).toEqual([
      path.join(repo, ".git"),
    ]);
    expect(await resolveDevcontainerGitMetadata(repo)).toEqual([]);
    const plain = path.join(root, "plain");
    await mkdir(plain);
    expect(await resolveDevcontainerGitMetadata(plain)).toEqual([]);
    await writeFile(path.join(plain, ".git"), "gitdir: /does/not/exist\n");
    await expect(resolveDevcontainerGitMetadata(plain)).rejects.toThrow(
      "Git metadata",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("IDE Claude state is created once and never overwritten", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-claude-"));
  try {
    const created = await ensureDevcontainerClaudeState(home);
    expect(created).toEqual({
      claudeDir: path.join(home, ".claude"),
      claudeJson: path.join(home, ".claude.json"),
    });
    expect(await readFile(created.claudeJson, "utf8")).toBe("{}\n");

    await writeFile(created.claudeJson, '{"kept":true}\n');
    await writeFile(path.join(created.claudeDir, "marker"), "");
    await ensureDevcontainerClaudeState(home);
    expect(await readFile(created.claudeJson, "utf8")).toBe('{"kept":true}\n');
    expect(await readFile(path.join(created.claudeDir, "marker"), "utf8")).toBe(
      "",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
