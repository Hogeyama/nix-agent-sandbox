/**
 * CLI E2E tests: nas の公開実行経路をそのまま通す
 *
 * deno run main.ts をサブプロセスとして起動し、設定読込、ステージ実行、
 * エージェント起動までをまとめて検証する。
 *
 * 実エージェント依存を避けるため、テストでは一時的な fake codex バイナリを PATH
 * の先頭に置き、コンテナ内へ mount されたそのバイナリが実行されることを確認する。
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";

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

async function isProxyImageAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("docker", {
      args: ["image", "inspect", "ubuntu/squid"],
      stdout: "null",
      stderr: "null",
    });
    const result = await cmd.output();
    return result.success;
  } catch {
    return false;
  }
}

const proxyAvailable = dockerAvailable && await isProxyImageAvailable();

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
// Proxy E2E tests
// ============================================================

async function withProxyProject(
  fn: (projectDir: string, env: Record<string, string>) => Promise<void>,
): Promise<void> {
  const rootDir = await makeTempDir("nas-proxy-e2e-");
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

    // Mock agent that curls allowed and blocked domains, reporting HTTP status
    const fakeCodexPath = path.join(binDir, "codex");
    await Deno.writeTextFile(
      fakeCodexPath,
      [
        "#!/bin/sh",
        // curl allowed domain (github.com)
        'ALLOWED=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://github.com/ 2>/dev/null)',
        'printf "ALLOWED_STATUS=%s\\n" "$ALLOWED"',
        // curl blocked domain (example.com)
        'BLOCKED=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://example.com/ 2>/dev/null)',
        'printf "BLOCKED_STATUS=%s\\n" "$BLOCKED"',
        // verify proxy env vars are set
        'printf "http_proxy=%s\\n" "$http_proxy"',
        'printf "https_proxy=%s\\n" "$https_proxy"',
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
        "    network:",
        "      allowlist:",
        "        - github.com",
        "    extra-mounts: []",
        "    env: []",
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
  name: "CLI E2E: proxy allows listed domain and blocks unlisted domain",
  ignore: !proxyAvailable || !canBindMount,
  async fn() {
    await withProxyProject(async (projectDir, env) => {
      const result = await runNas(["test"], {
        cwd: projectDir,
        env,
      });

      assertEquals(
        result.code,
        0,
        `nas exited with ${result.code}: ${result.stderr}`,
      );

      // proxy env vars should be set
      assertEquals(
        result.stdout.includes("http_proxy=http://"),
        true,
        "http_proxy should be set",
      );

      // allowed domain: expect 2xx or 3xx
      const allowedMatch = result.stdout.match(/ALLOWED_STATUS=(\d+)/);
      assertEquals(allowedMatch !== null, true, "Should report allowed status");
      const allowedStatus = parseInt(allowedMatch![1], 10);
      assertEquals(
        allowedStatus >= 200 && allowedStatus < 400,
        true,
        `Expected 2xx/3xx for allowed domain, got ${allowedStatus}`,
      );

      // blocked domain: expect 403 (squid deny)
      const blockedMatch = result.stdout.match(/BLOCKED_STATUS=(\d+)/);
      assertEquals(blockedMatch !== null, true, "Should report blocked status");
      const blockedStatus = parseInt(blockedMatch![1], 10);
      assertEquals(
        blockedStatus,
        403,
        `Expected 403 for blocked domain, got ${blockedStatus}`,
      );
    });
  },
});
