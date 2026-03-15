/**
 * CLI E2E tests: nas の公開実行経路をそのまま通す
 *
 * deno run main.ts をサブプロセスとして起動し、設定読込、ステージ実行、
 * エージェント起動までをまとめて検証する。
 *
 * 実エージェント依存を避けるため、テストでは一時的な fake codex バイナリを PATH
 * の先頭に置き、コンテナ内へ mount されたそのバイナリが実行されることを確認する。
 */

import { assertEquals, assertMatch } from "@std/assert";
import * as path from "@std/path";
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

async function makeTempDir(prefix: string): Promise<string> {
  const base = SHARED_TMP ?? "/tmp";
  const name = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  const dir = path.join(base, name);
  await Deno.mkdir(dir, { recursive: true });
  if (SHARED_TMP) {
    await Deno.chmod(dir, 0o1777);
  }
  return dir;
}

async function makeWritableForDind(target: string): Promise<void> {
  if (!SHARED_TMP) return;
  await Deno.chmod(target, 0o1777);
}

async function runNas(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-all", MAIN_TS, ...args],
    cwd: options.cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      ...options.env,
      DENO_COVERAGE: path.join(options.cwd, ".coverage"),
    },
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

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
// Network approval CLI E2E tests
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

async function exists(targetPath: string): Promise<boolean> {
  try {
    await Deno.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
