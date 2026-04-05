/**
 * CLI E2E tests
 *
 * main() 関数を直接呼び出すのではなく、deno run でプロセスとして実行し
 * 終了コード・stdout・stderr を検証する。
 *
 * Docker を使うテスト（パイプライン経由でエージェント起動）は
 * ignore: !dockerAvailable でガードされ、Docker 不在時はスキップされる。
 */

import { assertEquals, assertMatch } from "@std/assert";
import * as path from "@std/path";
import {
  HostExecBroker,
  sendHostExecBrokerRequest,
} from "../src/hostexec/broker.ts";
import {
  hostExecBrokerSocketPath,
  resolveHostExecRuntimePaths,
  writeHostExecSessionRegistry,
} from "../src/hostexec/registry.ts";
import type { PendingListResponse } from "../src/hostexec/types.ts";
import { sendBrokerRequest, SessionBroker } from "../src/network/broker.ts";
import {
  brokerSocketPath,
  pendingSessionDir,
  resolveNetworkRuntimePaths,
  writeSessionRegistry,
} from "../src/network/registry.ts";
import {
  type AuthorizeRequest,
  type DecisionResponse,
  hashToken,
  type PendingEntry,
} from "../src/network/protocol.ts";

// ============================================================
// Shared helpers
// ============================================================

const MAIN_TS = path.join(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
  "main.ts",
);

const SHARED_TMP = Deno.env.get("NAS_DIND_SHARED_TMP");
const DOCKER_HOST = Deno.env.get("DOCKER_HOST");
const canBindMount = SHARED_TMP !== undefined || !DOCKER_HOST;

async function isDockerAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    });
    const status = await cmd.output();
    return status.success;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();

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
    env: options.env
      ? {
        ...options.env,
        ...(options.cwd
          ? { DENO_COVERAGE: path.join(options.cwd, ".coverage") }
          : {}),
      }
      : undefined,
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

function makeTempDir(prefix: string): Promise<string> {
  if (SHARED_TMP) {
    return (async () => {
      const name = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
      const dir = path.join(SHARED_TMP, name);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.chmod(dir, 0o1777);
      return dir;
    })();
  }
  return Deno.makeTempDir({ prefix });
}

async function makeWritableForDind(target: string): Promise<void> {
  if (!SHARED_TMP) return;
  await Deno.chmod(target, 0o1777);
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await Deno.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// CLI: --help
// ============================================================

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

Deno.test("CLI: help includes quiet option", async () => {
  const result = await runNas(["--help"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.includes("--quiet"), true);
});

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

Deno.test("CLI: --help with -- still shows help", async () => {
  const result = await runNas(["--help", "--", "extra", "args"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.includes("nas - Nix Agent Sandbox"), true);
});

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

// ============================================================
// CLI: --version
// ============================================================

Deno.test("CLI: --version shows version and exits 0", async () => {
  const result = await runNas(["--version"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim().startsWith("nas "), true);
  assertEquals(/^nas \d+\.\d+\.\d+$/.test(result.stdout.trim()), true);
});

Deno.test("CLI: -V shows version and exits 0", async () => {
  const result = await runNas(["-V"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim().startsWith("nas "), true);
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

// ============================================================
// CLI: config errors
// ============================================================

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

// ============================================================
// CLI: worktree subcommand
// ============================================================

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

Deno.test("CLI: worktree list shows existing nas worktrees", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-show-" });
  try {
    await initGitRepo(tmpDir);
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

Deno.test("CLI: worktree clean --force removes nas worktrees", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-rm-" });
  try {
    await initGitRepo(tmpDir);
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

    const listResult = await runNas(["worktree", "list"], { cwd: tmpDir });
    assertEquals(listResult.stdout.includes("No nas worktrees found"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: worktree clean -f -B removes worktrees and orphan branches", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "clitest-wt-fb-" });
  try {
    await initGitRepo(tmpDir);
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
    await new Deno.Command("git", {
      args: ["-C", tmpDir, "worktree", "remove", "--force", wtPath],
      stdout: "null",
      stderr: "null",
    }).output();

    const branchCheck = await new Deno.Command("git", {
      args: ["-C", tmpDir, "branch", "--list", "nas/*"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const branches = new TextDecoder().decode(branchCheck.stdout).trim();
    assertEquals(branches.includes("nas/orphan/2026-01-01T00-00-00"), true);

    const result = await runNas(["worktree", "clean", "-f", "-B"], {
      cwd: tmpDir,
    });
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("orphan branch"), true);

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

// ============================================================
// CLI: container subcommand
// ============================================================

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

// ============================================================
// CLI: hostexec subcommand
// ============================================================

Deno.test("CLI: hostexec pending lists queued approvals", async () => {
  const runtimeRoot = await Deno.makeTempDir({ prefix: "nas-cli-hostexec-" });
  const runtimeDir = `${runtimeRoot}/nas/hostexec`;
  const workspace = await Deno.makeTempDir({
    prefix: "nas-cli-hostexec-work-",
  });
  const oldToken = Deno.env.get("HOSTEXEC_CLI_TOKEN");
  Deno.env.set("HOSTEXEC_CLI_TOKEN", "cli-secret");
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_cli",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: {
      prompt: {
        enable: true,
        timeoutSeconds: 30,
        defaultScope: "capability",
        notify: "off",
      },
      secrets: {
        cli_token: { from: "env:HOSTEXEC_CLI_TOKEN", required: true },
      },
      rules: [{
        id: "deno-eval",
        match: { argv0: "deno", argRegex: "^eval\\b" },
        cwd: { mode: "workspace-only", allow: [] },
        env: { TOKEN: "secret:cli_token" },
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "prompt",
        fallback: "container",
      }],
    },
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_cli");
  await broker.start(socketPath);
  await writeHostExecSessionRegistry(paths, {
    version: 1,
    sessionId: "sess_cli",
    brokerSocket: socketPath,
    profileName: "test",
    createdAt: new Date().toISOString(),
    pid: Deno.pid,
  });
  try {
    const execPromise = sendHostExecBrokerRequest(socketPath, {
      version: 1,
      type: "execute",
      sessionId: "sess_cli",
      requestId: "req_cli",
      argv0: "deno",
      args: ["eval", "console.log(Deno.env.get('TOKEN'))"],
      cwd: workspace,
      tty: false,
    });
    await waitForHostExecPending(paths, 1);
    const result = await runNas([
      "hostexec",
      "pending",
      "--runtime-dir",
      runtimeDir,
    ]);
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("sess_cli req_cli deno-eval"), true);
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_cli",
    });
    await execPromise;
  } finally {
    if (oldToken !== undefined) Deno.env.set("HOSTEXEC_CLI_TOKEN", oldToken);
    else Deno.env.delete("HOSTEXEC_CLI_TOKEN");
    await broker.close().catch(() => {});
    await Deno.remove(runtimeRoot, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }
});

Deno.test("CLI: hostexec test forwards command args after --", async () => {
  const yaml = `
profiles:
  claude:
    agent: claude
    hostexec:
      rules:
        - id: gpg-sign
          match:
            argv0: gpg
            arg-regex: "^hoge$"
          cwd:
            mode: workspace-or-session-tmp
          approval: allow
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas(
      ["hostexec", "test", "--profile", "claude", "--", "gpg", "hoge"],
      { cwd: dir },
    );
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes('args string: "hoge"'), true);
    assertEquals(
      result.stdout.includes("Matched rule: gpg-sign (approval: allow)"),
      true,
    );
  });
});

Deno.test("CLI: hostexec test preserves positional args named like subcommand", async () => {
  const yaml = `
profiles:
  claude:
    agent: claude
    hostexec:
      rules:
        - id: deno-test
          match:
            argv0: deno
            arg-regex: '^-A\\s+test$'
          cwd:
            mode: workspace-or-session-tmp
          approval: allow
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas(
      ["hostexec", "test", "--profile", "claude", "--", "deno", "-A", "test"],
      { cwd: dir },
    );
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes('args string: "-A test"'), true);
    assertEquals(
      result.stdout.includes("Matched rule: deno-test (approval: allow)"),
      true,
    );
  });
});

// ============================================================
// CLI: audit subcommand
// ============================================================

Deno.test("CLI: audit with no logs shows empty message", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-audit-empty-" });
  try {
    const auditDir = path.join(tmpDir, "audit");
    await Deno.mkdir(auditDir, { recursive: true });
    const result = await runNas(["audit", "--audit-dir", auditDir]);
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("No audit log entries found"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: audit displays log entries in text format", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-audit-text-" });
  try {
    const auditDir = path.join(tmpDir, "audit");
    await Deno.mkdir(auditDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const entry = {
      id: "uuid-1",
      timestamp: `${today}T10:00:00.000Z`,
      domain: "network",
      sessionId: "sess_abc",
      requestId: "req_1",
      decision: "allow",
      reason: "allowlist match",
      target: "example.com:443",
    };
    await Deno.writeTextFile(
      path.join(auditDir, `${today}.jsonl`),
      JSON.stringify(entry) + "\n",
    );

    const result = await runNas(["audit", "--audit-dir", auditDir]);
    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("sess_abc"), true);
    assertEquals(result.stdout.includes("network"), true);
    assertEquals(result.stdout.includes("allow"), true);
    assertEquals(result.stdout.includes("example.com:443"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: audit --json outputs JSON array", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-audit-json-" });
  try {
    const auditDir = path.join(tmpDir, "audit");
    await Deno.mkdir(auditDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const entry = {
      id: "uuid-2",
      timestamp: `${today}T11:00:00.000Z`,
      domain: "hostexec",
      sessionId: "sess_def",
      requestId: "req_2",
      decision: "deny",
      reason: "no matching rule",
      command: "rm -rf /",
    };
    await Deno.writeTextFile(
      path.join(auditDir, `${today}.jsonl`),
      JSON.stringify(entry) + "\n",
    );

    const result = await runNas(["audit", "--json", "--audit-dir", auditDir]);
    assertEquals(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assertEquals(Array.isArray(parsed), true);
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0].sessionId, "sess_def");
    assertEquals(parsed[0].decision, "deny");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: audit --session filters by session", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-audit-sess-" });
  try {
    const auditDir = path.join(tmpDir, "audit");
    await Deno.mkdir(auditDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const entry1 = {
      id: "uuid-3",
      timestamp: `${today}T10:00:00.000Z`,
      domain: "network",
      sessionId: "sess_aaa",
      requestId: "req_3",
      decision: "allow",
      reason: "ok",
      target: "a.com:80",
    };
    const entry2 = {
      id: "uuid-4",
      timestamp: `${today}T10:01:00.000Z`,
      domain: "network",
      sessionId: "sess_bbb",
      requestId: "req_4",
      decision: "deny",
      reason: "blocked",
      target: "b.com:80",
    };
    await Deno.writeTextFile(
      path.join(auditDir, `${today}.jsonl`),
      JSON.stringify(entry1) + "\n" + JSON.stringify(entry2) + "\n",
    );

    const result = await runNas([
      "audit",
      "--session",
      "sess_aaa",
      "--json",
      "--audit-dir",
      auditDir,
    ]);
    assertEquals(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0].sessionId, "sess_aaa");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("CLI: audit --domain filters by domain", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cli-audit-dom-" });
  try {
    const auditDir = path.join(tmpDir, "audit");
    await Deno.mkdir(auditDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const entry1 = {
      id: "uuid-5",
      timestamp: `${today}T10:00:00.000Z`,
      domain: "network",
      sessionId: "sess_x",
      requestId: "req_5",
      decision: "allow",
      reason: "ok",
      target: "x.com:443",
    };
    const entry2 = {
      id: "uuid-6",
      timestamp: `${today}T10:01:00.000Z`,
      domain: "hostexec",
      sessionId: "sess_x",
      requestId: "req_6",
      decision: "deny",
      reason: "blocked",
      command: "ls",
    };
    await Deno.writeTextFile(
      path.join(auditDir, `${today}.jsonl`),
      JSON.stringify(entry1) + "\n" + JSON.stringify(entry2) + "\n",
    );

    const result = await runNas([
      "audit",
      "--domain",
      "hostexec",
      "--json",
      "--audit-dir",
      auditDir,
    ]);
    assertEquals(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0].domain, "hostexec");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================
// CLI E2E: full pipeline (Docker required)
// ============================================================

async function withFakeCodexProject(
  fn: (projectDir: string, env: Record<string, string>) => Promise<void>,
): Promise<void> {
  const rootDir = await makeTempDir("nas-cli-e2e-");
  try {
    const projectDir = path.join(rootDir, "project");
    const homeDir = path.join(rootDir, "home");
    const binDir = path.join(rootDir, "bin");

    await Deno.mkdir(projectDir, { recursive: true });
    await Deno.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await Deno.mkdir(binDir, { recursive: true });
    await makeWritableForDind(projectDir);
    await makeWritableForDind(homeDir);
    await makeWritableForDind(path.join(homeDir, ".codex"));
    await makeWritableForDind(binDir);

    const fakeCodexPath = path.join(binDir, "codex");
    await Deno.writeTextFile(
      fakeCodexPath,
      [
        "#!/bin/sh",
        'printf "PWD=%s\\n" "$PWD"',
        'printf "ARGS=%s\\n" "$*"',
        'if [ -n "$MY_VAR" ]; then printf "MY_VAR=%s\\n" "$MY_VAR"; fi',
        'if [ "$1" = "write-file" ]; then printf "written-by-fake-codex\\n" > "./from-agent.txt"; fi',
      ].join("\n"),
    );
    await Deno.chmod(fakeCodexPath, 0o755);

    await Deno.writeTextFile(
      path.join(projectDir, ".agent-sandbox.yml"),
      [
        "default: test",
        "profiles:",
        "  test:",
        "    agent: codex",
        "    nix:",
        "      enable: false",
        "    docker:",
        "      enable: false",
        "      shared: false",
        "    gcloud:",
        "      mountConfig: false",
        "    aws:",
        "      mountConfig: false",
        "    gpg:",
        "      forwardAgent: false",
        "    extra-mounts: []",
        "    env:",
        "      - key: MY_VAR",
        '        val: "from-config"',
      ].join("\n"),
    );

    const env = {
      HOME: homeDir,
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
    };

    await fn(projectDir, env);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "CLI E2E: launches agent through nas pipeline",
  ignore: !dockerAvailable || !canBindMount,
  async fn() {
    await withFakeCodexProject(async (projectDir, env) => {
      const result = await runNas(["test", "--", "hello", "world"], {
        cwd: projectDir,
        env,
      });

      assertEquals(result.code, 0);
      assertEquals(result.stdout.includes(`PWD=${projectDir}`), true);
      assertEquals(result.stdout.includes("ARGS=hello world"), true);
      assertEquals(result.stdout.includes("MY_VAR=from-config"), true);
    });
  },
});

Deno.test({
  name: "CLI E2E: agent writes into mounted workspace",
  ignore: !dockerAvailable || !canBindMount,
  async fn() {
    await withFakeCodexProject(async (projectDir, env) => {
      const outputPath = path.join(projectDir, "from-agent.txt");
      const result = await runNas(["test", "--", "write-file"], {
        cwd: projectDir,
        env,
      });

      assertEquals(result.code, 0);
      const content = await Deno.readTextFile(outputPath);
      assertEquals(content.trim(), "written-by-fake-codex");
    });
  },
});

// ============================================================
// CLI E2E: network subcommand
// ============================================================

interface BrokerFixture {
  runtimeDir: string;
  sessionId: string;
  socketPath: string;
  broker: SessionBroker;
}

async function withBrokerFixture(
  options: {
    promptEnabled?: boolean;
    timeoutSeconds?: number;
  } = {},
  fn: (fixture: BrokerFixture) => Promise<void>,
): Promise<void> {
  const runtimeDir = await makeTempDir("nas-network-e2e-");
  const sessionId = `sess_${
    crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  }`;
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const socketPath = brokerSocketPath(paths, sessionId);
  const broker = new SessionBroker({
    paths,
    sessionId,
    allowlist: [],
    denylist: [],
    promptEnabled: options.promptEnabled ?? true,
    timeoutSeconds: options.timeoutSeconds ?? 30,
    defaultScope: "host-port",
    notify: "off",
  });
  await broker.start(socketPath);
  await writeSessionRegistry(paths, {
    version: 1,
    sessionId,
    tokenHash: await hashToken("test-token"),
    brokerSocket: socketPath,
    profileName: "test",
    allowlist: [],
    promptEnabled: options.promptEnabled ?? true,
    createdAt: new Date().toISOString(),
    pid: Deno.pid,
  });

  try {
    await fn({ runtimeDir, sessionId, socketPath, broker });
  } finally {
    await broker.close().catch(() => {});
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
}

async function authorizeThroughBroker(
  socketPath: string,
  sessionId: string,
  requestId: string,
  host: string,
  port: number,
): Promise<DecisionResponse> {
  const request: AuthorizeRequest = {
    version: 1,
    type: "authorize",
    requestId,
    sessionId,
    target: { host, port },
    method: "CONNECT",
    requestKind: "connect",
    observedAt: new Date().toISOString(),
  };
  return await sendBrokerRequest<DecisionResponse>(socketPath, request);
}

async function waitForPending(
  socketPath: string,
): Promise<{ type: "pending"; items: PendingEntry[] }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pending = await sendBrokerRequest<
      { type: "pending"; items: PendingEntry[] }
    >(
      socketPath,
      { type: "list_pending" },
    );
    if (pending.items.length > 0) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for pending CLI entry");
}

Deno.test("CLI E2E: network pending lists queued approvals", async () => {
  await withBrokerFixture({}, async ({ runtimeDir, sessionId, socketPath }) => {
    const authorizePromise = authorizeThroughBroker(
      socketPath,
      sessionId,
      "req_pending",
      "api.openai.com",
      443,
    );
    await waitForPending(socketPath);

    const result = await runNas(
      ["network", "pending", "--runtime-dir", runtimeDir],
      { cwd: Deno.cwd() },
    );

    assertEquals(result.code, 0);
    assertMatch(
      result.stdout,
      new RegExp(`${sessionId} req_pending api\\.openai\\.com:443 pending`),
    );

    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_pending",
    });
    const decision = await authorizePromise;
    assertEquals(decision.decision, "deny");
  });
});

Deno.test("CLI E2E: network approve resumes pending request", async () => {
  await withBrokerFixture({}, async ({ runtimeDir, sessionId, socketPath }) => {
    const authorizePromise = authorizeThroughBroker(
      socketPath,
      sessionId,
      "req_approve_cli",
      "api.openai.com",
      443,
    );
    await waitForPending(socketPath);

    const result = await runNas(
      [
        "network",
        "approve",
        sessionId,
        "req_approve_cli",
        "--scope",
        "host-port",
        "--runtime-dir",
        runtimeDir,
      ],
      { cwd: Deno.cwd() },
    );

    assertEquals(result.code, 0);
    assertEquals(
      result.stdout.includes(`Approved ${sessionId} req_approve_cli`),
      true,
    );

    const decision = await authorizePromise;
    assertEquals(decision.decision, "allow");
    assertEquals(decision.scope, "host-port");
  });
});

Deno.test("CLI E2E: network deny rejects pending request", async () => {
  await withBrokerFixture({}, async ({ runtimeDir, sessionId, socketPath }) => {
    const authorizePromise = authorizeThroughBroker(
      socketPath,
      sessionId,
      "req_deny_cli",
      "example.com",
      443,
    );
    await waitForPending(socketPath);

    const result = await runNas(
      [
        "network",
        "deny",
        sessionId,
        "req_deny_cli",
        "--runtime-dir",
        runtimeDir,
      ],
      { cwd: Deno.cwd() },
    );

    assertEquals(result.code, 0);
    assertEquals(
      result.stdout.includes(`Denied ${sessionId} req_deny_cli`),
      true,
    );

    const decision = await authorizePromise;
    assertEquals(decision.decision, "deny");
  });
});

Deno.test("CLI E2E: network gc removes stale runtime state", async () => {
  const runtimeDir = await makeTempDir("nas-network-gc-");
  try {
    const paths = await resolveNetworkRuntimePaths(runtimeDir);
    const sessionId = "sess_stale";
    const staleSocket = brokerSocketPath(paths, sessionId);
    await Deno.mkdir(pendingSessionDir(paths, sessionId), { recursive: true });
    await Deno.writeTextFile(staleSocket, "");
    await Deno.writeTextFile(paths.authRouterSocket, "");
    await Deno.writeTextFile(paths.authRouterPidFile, "999999\n");
    await writeSessionRegistry(paths, {
      version: 1,
      sessionId,
      tokenHash: await hashToken("stale-token"),
      brokerSocket: staleSocket,
      profileName: "test",
      allowlist: [],
      promptEnabled: true,
      createdAt: new Date().toISOString(),
      pid: 999999,
    });

    const result = await runNas(
      ["network", "gc", "--runtime-dir", runtimeDir],
      { cwd: Deno.cwd() },
    );

    assertEquals(result.code, 0);
    assertEquals(
      result.stdout.includes(
        "GC removed 1 session(s), 1 pending dir(s), 1 broker socket(s).",
      ),
      true,
    );
    assertEquals(await exists(paths.authRouterSocket), false);
    assertEquals(await exists(paths.authRouterPidFile), false);
    assertEquals(await exists(staleSocket), false);
  } finally {
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

// ============================================================
// Internal helpers
// ============================================================

async function waitForHostExecPending(
  paths: Awaited<ReturnType<typeof resolveHostExecRuntimePaths>>,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const items = await sendHostExecBrokerRequest<PendingListResponse>(
      hostExecBrokerSocketPath(paths, "sess_cli"),
      { type: "list_pending" },
    );
    if (items.type === "pending" && items.items.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for hostexec pending entry");
}
