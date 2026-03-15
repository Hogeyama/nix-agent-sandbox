/**
 * E2E tests: CLI エントリポイント
 *
 * main() 関数を直接呼び出すのではなく、deno run でプロセスとして実行し
 * 終了コード・stdout・stderr を検証する。
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";

const MAIN_TS = path.join(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
  "main.ts",
);

/** nas CLI をサブプロセスとして実行するヘルパー */
async function runNas(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-all", MAIN_TS, ...args],
    cwd: options.cwd,
    stdout: "piped",
    stderr: "piped",
    env: options.env,
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** 一時ディレクトリに設定ファイルを配置するヘルパー */
async function withTempConfig(
  yaml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-test-" });
  try {
    await Deno.writeTextFile(
      path.join(tmpDir, ".agent-sandbox.yml"),
      yaml,
    );
    await fn(tmpDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/** 一時 git リポジトリを初期化し、テストに必要なローカル設定を入れる */
async function initGitRepo(dir: string): Promise<void> {
  await new Deno.Command("git", {
    args: ["init", dir],
    stdout: "null",
    stderr: "null",
  }).output();
  await new Deno.Command("git", {
    args: ["-C", dir, "config", "user.name", "nas-test"],
    stdout: "null",
    stderr: "null",
  }).output();
  await new Deno.Command("git", {
    args: ["-C", dir, "config", "user.email", "nas-test@example.com"],
    stdout: "null",
    stderr: "null",
  }).output();
  await new Deno.Command("git", {
    args: ["-C", dir, "config", "commit.gpgsign", "false"],
    stdout: "null",
    stderr: "null",
  }).output();
  await new Deno.Command("git", {
    args: ["-C", dir, "commit", "--allow-empty", "-m", "init"],
    stdout: "null",
    stderr: "null",
  }).output();
}

// --- --help ---

Deno.test("CLI: --help shows usage and exits 0", async () => {
  const result = await runNas(["--help"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.includes("nas - Nix Agent Sandbox"), true);
  assertEquals(result.stdout.includes("Usage:"), true);
  assertEquals(result.stdout.includes("Subcommands:"), true);
  assertEquals(result.stdout.includes("Options:"), true);
  assertEquals(result.stdout.includes("container"), true);
});

Deno.test("CLI: -h shows usage and exits 0", async () => {
  const result = await runNas(["-h"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.includes("nas - Nix Agent Sandbox"), true);
});

// --- --version ---

Deno.test("CLI: --version shows version and exits 0", async () => {
  const result = await runNas(["--version"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim().startsWith("nas "), true);
  // バージョン形式の確認
  assertEquals(/^nas \d+\.\d+\.\d+$/.test(result.stdout.trim()), true);
});

Deno.test("CLI: -V shows version and exits 0", async () => {
  const result = await runNas(["-V"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim().startsWith("nas "), true);
});

// --- 設定ファイルなしでのエラー ---

Deno.test("CLI: exits with error when no config file found", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-noconf-" });
  try {
    const result = await runNas([], { cwd: tmpDir, env: { HOME: tmpDir } });
    assertEquals(result.code, 1);
    assertEquals(result.stderr.includes("not found"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- 存在しないプロファイル ---

Deno.test("CLI: exits with error for nonexistent profile", async () => {
  const yaml = `
profiles:
  dev:
    agent: claude
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas(["nonexistent"], { cwd: dir });
    assertEquals(result.code, 1);
    assertEquals(result.stderr.includes("not found"), true);
  });
});

// --- 不正な設定ファイル ---

Deno.test("CLI: exits with error for invalid YAML config", async () => {
  const yaml = `
profiles:
  test:
    agent: invalid_agent
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas([], { cwd: dir });
    assertEquals(result.code, 1);
    assertEquals(result.stderr.includes("agent must be one of"), true);
  });
});

Deno.test("CLI: exits with error for empty profiles", async () => {
  const yaml = `
profiles: {}
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas([], { cwd: dir, env: { HOME: dir } });
    assertEquals(result.code, 1);
    assertEquals(result.stderr.includes("at least one entry"), true);
  });
});

// --- --help はプロファイルエラーより優先 ---

Deno.test("CLI: --help takes precedence over missing config", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-help-" });
  try {
    const result = await runNas(["--help"], { cwd: tmpDir });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("nas - Nix Agent Sandbox"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: --version takes precedence over missing config", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-ver-" });
  try {
    const result = await runNas(["--version"], { cwd: tmpDir });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.trim().startsWith("nas "), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- worktree サブコマンド ---

Deno.test("CLI: worktree list works in a git repo", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-" });
  try {
    await initGitRepo(tmpDir);

    const result = await runNas(["worktree", "list"], { cwd: tmpDir });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("No nas worktrees found"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: worktree with unknown subcommand exits with error", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-unk-" });
  try {
    await initGitRepo(tmpDir);

    const result = await runNas(["worktree", "unknown"], { cwd: tmpDir });
    assertEquals(result.code, 1);
    assertEquals(
      result.stderr.includes("Unknown worktree subcommand"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: worktree clean --force on empty repo", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-clean-" });
  try {
    await initGitRepo(tmpDir);

    const result = await runNas(["worktree", "clean", "--force"], {
      cwd: tmpDir,
    });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("No nas worktrees found"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: container clean succeeds when no unused sidecars exist", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-container-clean-" });
  try {
    const first = await runNas(["container", "clean"], { cwd: tmpDir });
    assertEquals(first.code, 0);

    const result = await runNas(["container", "clean"], { cwd: tmpDir });
    assertEquals(result.code, 0);
    assertEquals(
      result.stdout.includes("No unused nas containers found"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: container with unknown subcommand exits with error", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-container-unk-" });
  try {
    const result = await runNas(["container", "unknown"], { cwd: tmpDir });
    assertEquals(result.code, 1);
    assertEquals(
      result.stderr.includes("Unknown container subcommand"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- worktree list with existing nas worktrees ---

Deno.test("CLI: worktree list shows existing nas worktrees", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-show-" });
  try {
    await initGitRepo(tmpDir);

    // nas worktree を手動で作成
    const wtPath = path.join(
      tmpDir,
      ".git",
      "nas-worktrees",
      "nas-test-2026-01-01T00-00-00",
    );
    await Deno.mkdir(path.join(tmpDir, ".git", "nas-worktrees"), {
      recursive: true,
    });
    await new Deno.Command("git", {
      args: [
        "-C",
        tmpDir,
        "worktree",
        "add",
        "-b",
        "nas/test/2026-01-01T00-00-00",
        wtPath,
        "HEAD",
      ],
      stdout: "null",
      stderr: "null",
    }).output();

    const result = await runNas(["worktree", "list"], { cwd: tmpDir });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("nas-test-2026-01-01T00-00-00"), true);
    assertEquals(result.stdout.includes("nas/test/2026-01-01T00-00-00"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- worktree clean --force removes worktrees ---

Deno.test("CLI: worktree clean --force removes nas worktrees", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-rm-" });
  try {
    await initGitRepo(tmpDir);

    // nas worktree を作成
    const wtPath = path.join(
      tmpDir,
      ".git",
      "nas-worktrees",
      "nas-prof-2026-01-01T00-00-00",
    );
    await Deno.mkdir(path.join(tmpDir, ".git", "nas-worktrees"), {
      recursive: true,
    });
    await new Deno.Command("git", {
      args: [
        "-C",
        tmpDir,
        "worktree",
        "add",
        "-b",
        "nas/prof/2026-01-01T00-00-00",
        wtPath,
        "HEAD",
      ],
      stdout: "null",
      stderr: "null",
    }).output();

    const result = await runNas(["worktree", "clean", "--force"], {
      cwd: tmpDir,
    });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("Removed"), true);

    // リスト確認
    const listResult = await runNas(["worktree", "list"], { cwd: tmpDir });
    assertEquals(listResult.stdout.includes("No nas worktrees found"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- worktree clean -f -B removes worktrees and branches ---

Deno.test("CLI: worktree clean -f -B removes worktrees and orphan branches", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-fb-" });
  try {
    await initGitRepo(tmpDir);

    // worktree を作って消す → orphan branch ができる
    const wtPath = path.join(
      tmpDir,
      ".git",
      "nas-worktrees",
      "nas-orphan-2026-01-01T00-00-00",
    );
    await Deno.mkdir(path.join(tmpDir, ".git", "nas-worktrees"), {
      recursive: true,
    });
    await new Deno.Command("git", {
      args: [
        "-C",
        tmpDir,
        "worktree",
        "add",
        "-b",
        "nas/orphan/2026-01-01T00-00-00",
        wtPath,
        "HEAD",
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    // worktree を削除（ブランチは残す）
    await new Deno.Command("git", {
      args: ["-C", tmpDir, "worktree", "remove", "--force", wtPath],
      stdout: "null",
      stderr: "null",
    }).output();

    // ブランチがまだ存在することを確認
    const branchCheck = await new Deno.Command("git", {
      args: ["-C", tmpDir, "branch", "--list", "nas/*"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const branches = new TextDecoder().decode(branchCheck.stdout).trim();
    assertEquals(branches.includes("nas/orphan/2026-01-01T00-00-00"), true);

    // clean -f -B で orphan ブランチも削除
    const result = await runNas(["worktree", "clean", "-f", "-B"], {
      cwd: tmpDir,
    });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("orphan branch"), true);

    // ブランチが削除されたことを確認
    const branchAfter = await new Deno.Command("git", {
      args: ["-C", tmpDir, "branch", "--list", "nas/*"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const branchesAfter = new TextDecoder().decode(branchAfter.stdout).trim();
    assertEquals(branchesAfter, "");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- `--` 以降の引数 ---

Deno.test("CLI: --help with -- still shows help", async () => {
  const result = await runNas(["--help", "--", "extra", "args"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.includes("nas - Nix Agent Sandbox"), true);
});

// --- 複数プロファイルでデフォルトなし ---

Deno.test("CLI: multiple profiles without default exits with error", async () => {
  const yaml = `
profiles:
  a:
    agent: claude
  b:
    agent: copilot
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas([], { cwd: dir, env: { HOME: dir } });
    assertEquals(result.code, 1);
    assertEquals(
      result.stderr.includes("No profile specified"),
      true,
    );
  });
});

// --- ヘルプのコンテンツ検証 ---

Deno.test("CLI: help includes all subcommands", async () => {
  const result = await runNas(["--help"]);
  assertEquals(result.stdout.includes("rebuild"), true);
  assertEquals(result.stdout.includes("worktree"), true);
});

Deno.test("CLI: help includes example commands", async () => {
  const result = await runNas(["--help"]);
  assertEquals(result.stdout.includes("nas rebuild"), true);
  assertEquals(result.stdout.includes("nas worktree list"), true);
  assertEquals(result.stdout.includes("nas worktree clean"), true);
  assertEquals(result.stdout.includes('nas copilot-nix -p "list files"'), true);
  assertEquals(result.stdout.includes('nas -- -p "list files"'), true);
});
