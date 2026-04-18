import { expect, test } from "bun:test";

/**
 * CLI E2E tests
 *
 * main() 関数を直接呼び出すのではなく、bun run でプロセスとして実行し
 * 終了コード・stdout・stderr を検証する。
 *
 * Docker を使うテスト（パイプライン経由でエージェント起動）は
 * ignore: !dockerAvailable でガードされ、Docker 不在時はスキップされる。
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditLog } from "../src/audit/store.ts";
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
import { SessionBroker, sendBrokerRequest } from "../src/network/broker.ts";
import {
  type AuthorizeRequest,
  type DecisionResponse,
  hashToken,
  type PendingEntry,
} from "../src/network/protocol.ts";
import {
  brokerSocketPath,
  pendingSessionDir,
  resolveNetworkRuntimePaths,
  writeSessionRegistry,
} from "../src/network/registry.ts";

// ============================================================
// Shared helpers
// ============================================================

const MAIN_TS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "main.ts",
);

const SHARED_TMP = process.env.NAS_DIND_SHARED_TMP;
const DOCKER_HOST = process.env.DOCKER_HOST;
const canBindMount = SHARED_TMP !== undefined || !DOCKER_HOST;

async function isDockerAvailable(): Promise<boolean> {
  try {
    const exitCode = await Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return exitCode === 0;
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
  // Strip outer nas session id so child nas invocations don't reuse our
  // session id / hostexec wrappers (which causes symlink-EEXIST collisions
  // when tests run inside a nas container). Keep hostexec wrapper env
  // (NAS_HOSTEXEC_SOCKET etc.) so that any `git` invoked via the mounted
  // /opt/nas/hostexec/bin shim can still reach its broker.
  const cleanedParent: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "NAS_SESSION_ID",
    "NAS_HOSTEXEC_SESSION_ID",
    "NAS_HOSTEXEC_SESSION_TMP",
  ]) {
    delete cleanedParent[key];
  }
  const proc = Bun.spawn(["bun", "run", MAIN_TS, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
    env: options.env ? { ...cleanedParent, ...options.env } : cleanedParent,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** 一時ディレクトリに設定ファイルを配置するヘルパー */
async function withTempConfig(
  yaml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-test-"));
  try {
    await writeFile(path.join(tmpDir, ".agent-sandbox.yml"), yaml);
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** 一時 git リポジトリを初期化し、テストに必要なローカル設定を入れる */
async function initGitRepo(dir: string): Promise<void> {
  await Bun.spawn(["git", "init", dir], { stdout: "ignore", stderr: "ignore" })
    .exited;
  await Bun.spawn(["git", "-C", dir, "config", "user.name", "nas-test"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  await Bun.spawn(
    ["git", "-C", dir, "config", "user.email", "nas-test@example.com"],
    { stdout: "ignore", stderr: "ignore" },
  ).exited;
  await Bun.spawn(["git", "-C", dir, "config", "commit.gpgsign", "false"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  await Bun.spawn(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
}

function makeTempDir(prefix: string): Promise<string> {
  if (SHARED_TMP) {
    return (async () => {
      const name = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
      const dir = path.join(SHARED_TMP, name);
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o1777);
      return dir;
    })();
  }
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function makeWritableForDind(target: string): Promise<void> {
  if (!SHARED_TMP) return;
  await chmod(target, 0o1777);
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// CLI: --help
// ============================================================

test("CLI: --help shows usage and exits 0", async () => {
  const result = await runNas(["--help"]);
  expect(result.code).toEqual(0);
  expect(result.stdout.includes("nas - Nix Agent Sandbox")).toEqual(true);
  expect(result.stdout.includes("Usage:")).toEqual(true);
  expect(result.stdout.includes("Subcommands:")).toEqual(true);
  expect(result.stdout.includes("Options:")).toEqual(true);
  expect(result.stdout.includes("container")).toEqual(true);
});

test("CLI: -h shows usage and exits 0", async () => {
  const result = await runNas(["-h"]);
  expect(result.code).toEqual(0);
  expect(result.stdout.includes("nas - Nix Agent Sandbox")).toEqual(true);
});

test("CLI: help includes quiet option", async () => {
  const result = await runNas(["--help"]);
  expect(result.code).toEqual(0);
  expect(result.stdout.includes("--quiet")).toEqual(true);
});

test("CLI: help includes all subcommands", async () => {
  const result = await runNas(["--help"]);
  expect(result.stdout.includes("rebuild")).toEqual(true);
  expect(result.stdout.includes("worktree")).toEqual(true);
});

test("CLI: help includes example commands", async () => {
  const result = await runNas(["--help"]);
  expect(result.stdout.includes("nas rebuild")).toEqual(true);
  expect(result.stdout.includes("nas worktree list")).toEqual(true);
  expect(result.stdout.includes("nas worktree clean")).toEqual(true);
  expect(result.stdout.includes('nas copilot-nix -p "list files"')).toEqual(
    true,
  );
  expect(result.stdout.includes('nas -- -p "list files"')).toEqual(true);
});

test("CLI: --help with -- still shows help", async () => {
  const result = await runNas(["--help", "--", "extra", "args"]);
  expect(result.code).toEqual(0);
  expect(result.stdout.includes("nas - Nix Agent Sandbox")).toEqual(true);
});

test("CLI: --help takes precedence over missing config", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-help-"));
  try {
    const result = await runNas(["--help"], { cwd: tmpDir });
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("nas - Nix Agent Sandbox")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// CLI: --version
// ============================================================

test("CLI: --version shows version and exits 0", async () => {
  const result = await runNas(["--version"]);
  expect(result.code).toEqual(0);
  expect(result.stdout.trim().startsWith("nas ")).toEqual(true);
  expect(/^nas \d+\.\d+\.\d+$/.test(result.stdout.trim())).toEqual(true);
});

test("CLI: -V shows version and exits 0", async () => {
  const result = await runNas(["-V"]);
  expect(result.code).toEqual(0);
  expect(result.stdout.trim().startsWith("nas ")).toEqual(true);
});

test("CLI: --version takes precedence over missing config", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-ver-"));
  try {
    const result = await runNas(["--version"], { cwd: tmpDir });
    expect(result.code).toEqual(0);
    expect(result.stdout.trim().startsWith("nas ")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// CLI: config errors
// ============================================================

test("CLI: exits with error when no config file found", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-noconf-"));
  try {
    const result = await runNas([], {
      cwd: tmpDir,
      env: { HOME: tmpDir, XDG_CONFIG_HOME: path.join(tmpDir, ".config") },
    });
    expect(result.code).toEqual(1);
    expect(result.stderr.includes("not found")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: exits with error for nonexistent profile", async () => {
  const yaml = `
profiles:
  dev:
    agent: claude
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas(["nonexistent"], { cwd: dir });
    expect(result.code).toEqual(1);
    expect(result.stderr.includes("not found")).toEqual(true);
  });
});

test("CLI: exits with error for invalid YAML config", async () => {
  const yaml = `
profiles:
  test:
    agent: invalid_agent
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas([], { cwd: dir });
    expect(result.code).toEqual(1);
    expect(result.stderr.includes("agent must be one of")).toEqual(true);
  });
});

test("CLI: exits with error for empty profiles", async () => {
  const yaml = `
profiles: {}
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas([], {
      cwd: dir,
      env: { HOME: dir, XDG_CONFIG_HOME: path.join(dir, ".config") },
    });
    expect(result.code).toEqual(1);
    expect(result.stderr.includes("at least one entry")).toEqual(true);
  });
});

test("CLI: multiple profiles without default exits with error", async () => {
  const yaml = `
profiles:
  a:
    agent: claude
  b:
    agent: copilot
`;
  await withTempConfig(yaml, async (dir) => {
    const result = await runNas([], {
      cwd: dir,
      env: { HOME: dir, XDG_CONFIG_HOME: path.join(dir, ".config") },
    });
    expect(result.code).toEqual(1);
    expect(result.stderr.includes("No profile specified")).toEqual(true);
  });
});

// ============================================================
// CLI: worktree subcommand
// ============================================================

test("CLI: worktree list works in a git repo", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "clitest-wt-"));
  try {
    await initGitRepo(tmpDir);
    const result = await runNas(["worktree", "list"], { cwd: tmpDir });
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("No nas worktrees found")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: worktree with unknown subcommand exits with error", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "clitest-wt-unk-"));
  try {
    await initGitRepo(tmpDir);
    const result = await runNas(["worktree", "unknown"], { cwd: tmpDir });
    expect(result.code).toEqual(1);
    expect(result.stderr.includes("Unknown worktree subcommand")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: worktree clean --force on empty repo", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "clitest-wt-clean-"));
  try {
    await initGitRepo(tmpDir);
    const result = await runNas(["worktree", "clean", "--force"], {
      cwd: tmpDir,
    });
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("No nas worktrees found")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: worktree list shows existing nas worktrees", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "clitest-wt-show-"));
  try {
    await initGitRepo(tmpDir);
    const wtPath = path.join(
      tmpDir,
      ".nas",
      "worktrees",
      "nas-test-2026-01-01T00-00-00",
    );
    await mkdir(path.join(tmpDir, ".nas", "worktrees"), {
      recursive: true,
    });
    await Bun.spawn(
      [
        "git",
        "-C",
        tmpDir,
        "worktree",
        "add",
        "-b",
        "nas/test/2026-01-01T00-00-00",
        wtPath,
        "HEAD",
      ],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;

    const result = await runNas(["worktree", "list"], { cwd: tmpDir });
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("nas-test-2026-01-01T00-00-00")).toEqual(
      true,
    );
    expect(result.stdout.includes("nas/test/2026-01-01T00-00-00")).toEqual(
      true,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: worktree clean --force removes nas worktrees", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "clitest-wt-rm-"));
  try {
    await initGitRepo(tmpDir);
    const wtPath = path.join(
      tmpDir,
      ".nas",
      "worktrees",
      "nas-prof-2026-01-01T00-00-00",
    );
    await mkdir(path.join(tmpDir, ".nas", "worktrees"), {
      recursive: true,
    });
    await Bun.spawn(
      [
        "git",
        "-C",
        tmpDir,
        "worktree",
        "add",
        "-b",
        "nas/prof/2026-01-01T00-00-00",
        wtPath,
        "HEAD",
      ],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;

    const result = await runNas(["worktree", "clean", "--force"], {
      cwd: tmpDir,
    });
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("Removed")).toEqual(true);

    const listResult = await runNas(["worktree", "list"], { cwd: tmpDir });
    expect(listResult.stdout.includes("No nas worktrees found")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: worktree clean -f -B removes worktrees and orphan branches", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "clitest-wt-fb-"));
  try {
    await initGitRepo(tmpDir);
    const wtPath = path.join(
      tmpDir,
      ".nas",
      "worktrees",
      "nas-orphan-2026-01-01T00-00-00",
    );
    await mkdir(path.join(tmpDir, ".nas", "worktrees"), {
      recursive: true,
    });
    await Bun.spawn(
      [
        "git",
        "-C",
        tmpDir,
        "worktree",
        "add",
        "-b",
        "nas/orphan/2026-01-01T00-00-00",
        wtPath,
        "HEAD",
      ],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
    await Bun.spawn(
      ["git", "-C", tmpDir, "worktree", "remove", "--force", wtPath],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;

    const branchCheck = await Bun.spawn(
      ["git", "-C", tmpDir, "branch", "--list", "nas/*"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const branches = (await new Response(branchCheck.stdout).text()).trim();
    expect(branches.includes("nas/orphan/2026-01-01T00-00-00")).toEqual(true);

    const result = await runNas(["worktree", "clean", "-f", "-B"], {
      cwd: tmpDir,
    });
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("orphan branch")).toEqual(true);

    const branchAfter = await Bun.spawn(
      ["git", "-C", tmpDir, "branch", "--list", "nas/*"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const branchesAfter = (
      await new Response(branchAfter.stdout).text()
    ).trim();
    expect(branchesAfter).toEqual("");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// CLI: container subcommand
// ============================================================

test("CLI: container with unknown subcommand exits with error", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "clitest-container-unk-"));
  try {
    const result = await runNas(["container", "unknown"], { cwd: tmpDir });
    expect(result.code).toEqual(1);
    expect(result.stderr.includes("Unknown container subcommand")).toEqual(
      true,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// CLI: hostexec subcommand
// ============================================================

test("CLI: hostexec pending lists queued approvals", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "nas-cli-hostexec-"));
  const runtimeDir = `${runtimeRoot}/nas/hostexec`;
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-cli-hostexec-work-"),
  );
  const oldToken = process.env.HOSTEXEC_CLI_TOKEN;
  process.env.HOSTEXEC_CLI_TOKEN = "cli-secret";
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
      rules: [
        {
          id: "deno-eval",
          match: { argv0: "deno", argRegex: "^eval\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: { TOKEN: "secret:cli_token" },
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
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
    pid: process.pid,
  });
  try {
    const execPromise = sendHostExecBrokerRequest(socketPath, {
      version: 1,
      type: "execute",
      sessionId: "sess_cli",
      requestId: "req_cli",
      argv0: "deno",
      args: ["eval", "console.log(process.env['TOKEN'])"],
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
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("sess_cli req_cli deno-eval")).toEqual(true);
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_cli",
    });
    await execPromise;
  } finally {
    if (oldToken !== undefined) process.env.HOSTEXEC_CLI_TOKEN = oldToken;
    else delete process.env.HOSTEXEC_CLI_TOKEN;
    await broker.close().catch(() => {});
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("CLI: hostexec test forwards command args after --", async () => {
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
    expect(result.code).toEqual(0);
    expect(result.stdout.includes('args string: "hoge"')).toEqual(true);
    expect(
      result.stdout.includes("Matched rule: gpg-sign (approval: allow)"),
    ).toEqual(true);
  });
});

test("CLI: hostexec test preserves positional args named like subcommand", async () => {
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
    expect(result.code).toEqual(0);
    expect(result.stdout.includes('args string: "-A test"')).toEqual(true);
    expect(
      result.stdout.includes("Matched rule: deno-test (approval: allow)"),
    ).toEqual(true);
  });
});

// ============================================================
// CLI: audit subcommand
// ============================================================

test("CLI: audit with no logs shows empty message", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-audit-empty-"));
  try {
    const auditDir = path.join(tmpDir, "audit");
    await mkdir(auditDir, { recursive: true });
    const result = await runNas(["audit", "--audit-dir", auditDir]);
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("No audit log entries found")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: audit displays log entries in text format", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-audit-text-"));
  try {
    const auditDir = path.join(tmpDir, "audit");
    const today = new Date().toISOString().slice(0, 10);
    await appendAuditLog(
      {
        id: "uuid-1",
        timestamp: `${today}T10:00:00.000Z`,
        domain: "network",
        sessionId: "sess_abc",
        requestId: "req_1",
        decision: "allow",
        reason: "allowlist match",
        target: "example.com:443",
      },
      auditDir,
    );

    const result = await runNas(["audit", "--audit-dir", auditDir]);
    expect(result.code).toEqual(0);
    expect(result.stdout.includes("sess_abc")).toEqual(true);
    expect(result.stdout.includes("network")).toEqual(true);
    expect(result.stdout.includes("allow")).toEqual(true);
    expect(result.stdout.includes("example.com:443")).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: audit --json outputs JSON array", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-audit-json-"));
  try {
    const auditDir = path.join(tmpDir, "audit");
    const today = new Date().toISOString().slice(0, 10);
    await appendAuditLog(
      {
        id: "uuid-2",
        timestamp: `${today}T11:00:00.000Z`,
        domain: "hostexec",
        sessionId: "sess_def",
        requestId: "req_2",
        decision: "deny",
        reason: "no matching rule",
        command: "rm -rf /",
      },
      auditDir,
    );

    const result = await runNas(["audit", "--json", "--audit-dir", auditDir]);
    expect(result.code).toEqual(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toEqual(true);
    expect(parsed.length).toEqual(1);
    expect(parsed[0].sessionId).toEqual("sess_def");
    expect(parsed[0].decision).toEqual("deny");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: audit --session filters by session", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-audit-sess-"));
  try {
    const auditDir = path.join(tmpDir, "audit");
    const today = new Date().toISOString().slice(0, 10);
    await appendAuditLog(
      {
        id: "uuid-3",
        timestamp: `${today}T10:00:00.000Z`,
        domain: "network",
        sessionId: "sess_aaa",
        requestId: "req_3",
        decision: "allow",
        reason: "ok",
        target: "a.com:80",
      },
      auditDir,
    );
    await appendAuditLog(
      {
        id: "uuid-4",
        timestamp: `${today}T10:01:00.000Z`,
        domain: "network",
        sessionId: "sess_bbb",
        requestId: "req_4",
        decision: "deny",
        reason: "blocked",
        target: "b.com:80",
      },
      auditDir,
    );

    const result = await runNas([
      "audit",
      "--session",
      "sess_aaa",
      "--json",
      "--audit-dir",
      auditDir,
    ]);
    expect(result.code).toEqual(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.length).toEqual(1);
    expect(parsed[0].sessionId).toEqual("sess_aaa");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: audit --domain filters by domain", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cli-audit-dom-"));
  try {
    const auditDir = path.join(tmpDir, "audit");
    const today = new Date().toISOString().slice(0, 10);
    await appendAuditLog(
      {
        id: "uuid-5",
        timestamp: `${today}T10:00:00.000Z`,
        domain: "network",
        sessionId: "sess_x",
        requestId: "req_5",
        decision: "allow",
        reason: "ok",
        target: "x.com:443",
      },
      auditDir,
    );
    await appendAuditLog(
      {
        id: "uuid-6",
        timestamp: `${today}T10:01:00.000Z`,
        domain: "hostexec",
        sessionId: "sess_x",
        requestId: "req_6",
        decision: "deny",
        reason: "blocked",
        command: "ls",
      },
      auditDir,
    );

    const result = await runNas([
      "audit",
      "--domain",
      "hostexec",
      "--json",
      "--audit-dir",
      auditDir,
    ]);
    expect(result.code).toEqual(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.length).toEqual(1);
    expect(parsed[0].domain).toEqual("hostexec");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
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

    await mkdir(projectDir, { recursive: true });
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await makeWritableForDind(projectDir);
    await makeWritableForDind(homeDir);
    await makeWritableForDind(path.join(homeDir, ".codex"));
    await makeWritableForDind(binDir);

    const fakeCodexPath = path.join(binDir, "codex");
    await writeFile(
      fakeCodexPath,
      [
        "#!/bin/sh",
        'printf "PWD=%s\\n" "$PWD"',
        'printf "ARGS=%s\\n" "$*"',
        'if [ -n "$MY_VAR" ]; then printf "MY_VAR=%s\\n" "$MY_VAR"; fi',
        'if [ "$1" = "write-file" ]; then printf "written-by-fake-codex\\n" > "./from-agent.txt"; fi',
      ].join("\n"),
    );
    await chmod(fakeCodexPath, 0o755);

    await writeFile(
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
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    await fn(projectDir, env);
  } finally {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

test.skipIf(!dockerAvailable || !canBindMount)(
  "CLI E2E: launches agent through nas pipeline",
  async () => {
    await withFakeCodexProject(async (projectDir, env) => {
      const result = await runNas(["test", "--", "hello", "world"], {
        cwd: projectDir,
        env,
      });

      expect(result.code).toEqual(0);
      expect(result.stdout.includes(`PWD=${projectDir}`)).toEqual(true);
      expect(result.stdout.includes("ARGS=hello world")).toEqual(true);
      expect(result.stdout.includes("MY_VAR=from-config")).toEqual(true);
    });
  },
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "CLI E2E: agent writes into mounted workspace",
  async () => {
    await withFakeCodexProject(async (projectDir, env) => {
      const outputPath = path.join(projectDir, "from-agent.txt");
      const result = await runNas(["test", "--", "write-file"], {
        cwd: projectDir,
        env,
      });

      expect(result.code).toEqual(0);
      const content = await readFile(outputPath, "utf8");
      expect(content.trim()).toEqual("written-by-fake-codex");
    });
  },
);

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
  const sessionId = `sess_${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
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
    pid: process.pid,
  });

  try {
    await fn({ runtimeDir, sessionId, socketPath, broker });
  } finally {
    await broker.close().catch(() => {});
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
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
    const pending = await sendBrokerRequest<{
      type: "pending";
      items: PendingEntry[];
    }>(socketPath, { type: "list_pending" });
    if (pending.items.length > 0) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for pending CLI entry");
}

test("CLI E2E: network pending lists queued approvals", async () => {
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
      { cwd: process.cwd() },
    );

    expect(result.code).toEqual(0);
    expect(result.stdout).toMatch(
      new RegExp(`${sessionId} req_pending api\\.openai\\.com:443 pending`),
    );

    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_pending",
    });
    const decision = await authorizePromise;
    expect(decision.decision).toEqual("deny");
  });
});

test("CLI E2E: network approve resumes pending request", async () => {
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
      { cwd: process.cwd() },
    );

    expect(result.code).toEqual(0);
    expect(
      result.stdout.includes(`Approved ${sessionId} req_approve_cli`),
    ).toEqual(true);

    const decision = await authorizePromise;
    expect(decision.decision).toEqual("allow");
    expect(decision.scope).toEqual("host-port");
  });
});

test("CLI E2E: network deny rejects pending request", async () => {
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
      { cwd: process.cwd() },
    );

    expect(result.code).toEqual(0);
    expect(result.stdout.includes(`Denied ${sessionId} req_deny_cli`)).toEqual(
      true,
    );

    const decision = await authorizePromise;
    expect(decision.decision).toEqual("deny");
  });
});

test("CLI E2E: network gc removes stale runtime state", async () => {
  const runtimeDir = await makeTempDir("nas-network-gc-");
  try {
    const paths = await resolveNetworkRuntimePaths(runtimeDir);
    const sessionId = "sess_stale";
    const staleSocket = brokerSocketPath(paths, sessionId);
    await mkdir(pendingSessionDir(paths, sessionId), { recursive: true });
    await writeFile(staleSocket, "");
    await writeFile(paths.authRouterSocket, "");
    await writeFile(paths.authRouterPidFile, "999999\n");
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
      { cwd: process.cwd() },
    );

    expect(result.code).toEqual(0);
    expect(
      result.stdout.includes(
        "GC removed 1 session(s), 1 pending dir(s), 1 broker socket(s).",
      ),
    ).toEqual(true);
    expect(await exists(paths.authRouterSocket)).toEqual(false);
    expect(await exists(paths.authRouterPidFile)).toEqual(false);
    expect(await exists(staleSocket)).toEqual(false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
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
