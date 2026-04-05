/**
 * Docker CLI ラッパー integration テスト
 *
 * - computeEmbedHash / envoy template: Docker daemon 不要、ファイル I/O のみ
 * - それ以外: 実 Docker daemon 必要（ignore ガードあり）
 * - unit テスト（Docker 不要・I/O 不要）は client_test.ts を参照
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  computeEmbedHash,
  dockerBuild,
  dockerExec,
  dockerImageExists,
  dockerIsRunning,
  dockerLogs,
  dockerNetworkConnect,
  dockerNetworkCreate,
  dockerNetworkRemove,
  dockerRemoveImage,
  dockerRm,
  dockerRun,
  dockerRunDetached,
  dockerStop,
  dockerVolumeRemove,
  getImageLabel,
  InterruptedCommandError,
  runInteractiveCommand,
} from "./client.ts";

const TEST_IMAGE = "alpine:latest";
const PREFIX = "nas-test-" + Date.now();
const SHARED_TMP = Deno.env.get("NAS_DIND_SHARED_TMP");
const DOCKER_HOST = Deno.env.get("DOCKER_HOST");
const canBindMount = SHARED_TMP !== undefined || !DOCKER_HOST;
const DOCKER_DAEMON_AVAILABLE = (() => {
  try {
    return new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
})();

async function makeDockerBindableTempDir(prefix: string): Promise<string> {
  const base = SHARED_TMP ?? "/tmp";
  const dir = `${base}/${prefix}${crypto.randomUUID().slice(0, 8)}`;
  await Deno.mkdir(dir, { recursive: true });
  if (SHARED_TMP) {
    await Deno.chmod(dir, 0o1777);
  }
  return dir;
}

async function startLongRunningContainer(
  name: string,
  envVars: Record<string, string> = {},
): Promise<void> {
  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    envArgs.push("-e", `${key}=${value}`);
  }
  const cmd = new Deno.Command("docker", {
    args: ["run", "-d", "--name", name, ...envArgs, TEST_IMAGE, "sleep", "300"],
    stdout: "null",
    stderr: "null",
  });
  const result = await cmd.output();
  if (!result.success) {
    throw new Error(`Failed to start container ${name}`);
  }
}

async function inspectDockerObject(
  ...args: string[]
): Promise<Record<string, unknown>> {
  const cmd = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) {
    throw new Error(
      `docker ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }

  return JSON.parse(new TextDecoder().decode(result.stdout))[0];
}

// --- computeEmbedHash / envoy template (Docker daemon 不要) ---

Deno.test("computeEmbedHash returns consistent hash", async () => {
  const hash1 = await computeEmbedHash();
  const hash2 = await computeEmbedHash();
  assertEquals(hash1, hash2);
  // SHA-256 hex is 64 chars
  assertEquals(hash1.length, 64);
});

Deno.test("computeEmbedHash matches embed and envoy assets", async () => {
  const parts: string[] = [];
  for (
    const [baseUrl, files] of [
      [
        new URL("./embed/", import.meta.url),
        ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"],
      ],
      [
        new URL("./envoy/", import.meta.url),
        ["envoy.template.yaml"],
      ],
    ] as const
  ) {
    for (const name of files) {
      parts.push(await Deno.readTextFile(new URL(name, baseUrl)));
    }
  }
  const data = new TextEncoder().encode(parts.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const expected = Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  assertEquals(await computeEmbedHash(), expected);
});

Deno.test("envoy template includes required proxy settings", async () => {
  const template = await Deno.readTextFile(
    new URL("./envoy/envoy.template.yaml", import.meta.url),
  );

  for (
    const fragment of [
      "0.0.0.0:15001",
      "envoy.filters.http.dynamic_forward_proxy",
      "envoy.filters.http.lua",
      "request_timeout: 0s",
      "timeout: 0s",
      "access_log:",
      "envoy.access_loggers.stdout",
      "pipe: { path: /nas-network/auth-router.sock }",
      "/authorize",
      "proxy-authorization",
      "host",
      "x-request-id",
      "x-nas-original-method",
      "x-nas-original-authority",
      "x-nas-original-url",
      "300000",
      'handle:headers():remove("proxy-authorization")',
    ]
  ) {
    assertEquals(template.includes(fragment), true);
  }
});

// --- dockerImageExists ---

Deno.test({
  name: "dockerImageExists: returns true for existing image",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const cmd = new Deno.Command("docker", {
      args: ["pull", "-q", TEST_IMAGE],
      stdout: "null",
      stderr: "null",
    });
    await cmd.output();

    const exists = await dockerImageExists(TEST_IMAGE);
    assertEquals(exists, true);
  },
});

// --- dockerBuild with labels ---

Deno.test({
  name: "dockerBuild: builds image with labels and getImageLabel reads them",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const tag = `${PREFIX}-build-label`;
    const tmpDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${tmpDir}/Dockerfile`, "FROM alpine:latest\n");
      await dockerBuild(tmpDir, tag, { "test.label": "hello-nas" });

      const labelValue = await getImageLabel(tag, "test.label");
      assertEquals(labelValue, "hello-nas");
    } finally {
      await dockerRemoveImage(tag, { force: true }).catch(() => {});
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

// --- dockerRunDetached ---

Deno.test({
  name: "dockerRunDetached: starts container in detached mode",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const containerName = `${PREFIX}-detached`;
    try {
      await dockerRunDetached({
        name: containerName,
        image: TEST_IMAGE,
        args: [],
        envVars: { "TEST_VAR": "detached_value" },
      });
      const inspectCmd = new Deno.Command("docker", {
        args: ["inspect", containerName],
        stdout: "null",
        stderr: "null",
      });
      const result = await inspectCmd.output();
      assertEquals(result.success, true);
    } finally {
      await dockerRm(containerName).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "dockerRunDetached: supports network, mounts, ports, labels, entrypoint, command",
  ignore: !DOCKER_DAEMON_AVAILABLE || !canBindMount,
  async fn() {
    const networkName = `${PREFIX}-detached-net`;
    const containerName = `${PREFIX}-detached-extended`;
    const tmpDir = await makeDockerBindableTempDir("nas-docker-client-");
    try {
      await Deno.writeTextFile(`${tmpDir}/hello.txt`, "hello");
      await dockerNetworkCreate(networkName);

      await dockerRunDetached({
        name: containerName,
        image: TEST_IMAGE,
        args: [],
        envVars: { "TEST_VAR": "detached_value" },
        network: networkName,
        mounts: [`type=bind,src=${tmpDir},dst=/workspace,readonly`],
        publishedPorts: ["127.0.0.1::8080"],
        labels: { "test.label": "extended" },
        entrypoint: "/bin/sh",
        command: ["-c", "sleep 300"],
      });

      const inspected = await inspectDockerObject("inspect", containerName) as {
        Config?: {
          Cmd?: string[];
          Entrypoint?: string[];
          Env?: string[];
          Labels?: Record<string, string>;
        };
        HostConfig?: {
          NetworkMode?: string;
        };
        Mounts?: Array<{
          Destination?: string;
          RW?: boolean;
          Source?: string;
          Type?: string;
        }>;
        NetworkSettings?: {
          Ports?: Record<
            string,
            Array<{ HostIp?: string; HostPort?: string }>
          >;
        };
      };

      assertEquals(inspected.HostConfig?.NetworkMode, networkName);
      assertEquals(inspected.Config?.Entrypoint, ["/bin/sh"]);
      assertEquals(inspected.Config?.Cmd, ["-c", "sleep 300"]);
      assertEquals(inspected.Config?.Labels?.["test.label"], "extended");
      assertEquals(
        inspected.Config?.Env?.includes("TEST_VAR=detached_value"),
        true,
      );
      assertEquals(
        inspected.Mounts?.some((mount) =>
          mount.Type === "bind" &&
          mount.Source === tmpDir &&
          mount.Destination === "/workspace" &&
          mount.RW === false
        ),
        true,
      );
      assertEquals(
        inspected.NetworkSettings?.Ports?.["8080/tcp"]?.[0]?.HostIp,
        "127.0.0.1",
      );
      assert(
        (inspected.NetworkSettings?.Ports?.["8080/tcp"]?.[0]?.HostPort ?? "")
          .length > 0,
      );
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await dockerNetworkRemove(networkName).catch(() => {});
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

// --- dockerIsRunning / dockerExec / dockerLogs / dockerStop / dockerRm ---

Deno.test({
  name: "container lifecycle: isRunning, exec, logs, stop, rm",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const containerName = `${PREFIX}-lifecycle`;
    try {
      await startLongRunningContainer(containerName, {
        "TEST_VAR": "test_value",
      });

      const running = await dockerIsRunning(containerName);
      assertEquals(running, true);

      const execResult = await dockerExec(containerName, ["echo", "hello"]);
      assertEquals(execResult.code, 0);
      assertEquals(execResult.stdout, "hello");

      const envResult = await dockerExec(containerName, [
        "sh",
        "-c",
        "echo $TEST_VAR",
      ]);
      assertEquals(envResult.code, 0);
      assertEquals(envResult.stdout, "test_value");

      const userResult = await dockerExec(
        containerName,
        ["id", "-u"],
        { user: "root" },
      );
      assertEquals(userResult.code, 0);
      assertEquals(userResult.stdout, "0");

      const logs = await dockerLogs(containerName);
      assertEquals(typeof logs, "string");

      const tailLogs = await dockerLogs(containerName, { tail: 1 });
      assertEquals(typeof tailLogs, "string");

      await dockerStop(containerName, { timeoutSeconds: 0 });

      const stoppedRunning = await dockerIsRunning(containerName);
      assertEquals(stoppedRunning, false);

      await dockerRm(containerName);
    } catch (e) {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      throw e;
    }
  },
});

// --- dockerExec: failing command ---

Deno.test({
  name: "dockerExec: returns non-zero code for failing command",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const containerName = `${PREFIX}-exec-fail`;
    try {
      await startLongRunningContainer(containerName);

      const result = await dockerExec(containerName, ["false"]);
      assertEquals(result.code !== 0, true);
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
    }
  },
});

// --- dockerRun: non-interactive ---

Deno.test({
  name: "dockerRun: runs non-interactive command successfully",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    await dockerRun({
      image: TEST_IMAGE,
      args: [],
      envVars: { "GREETING": "world" },
      command: ["sh", "-c", "echo hello $GREETING"],
      interactive: false,
    });
  },
});

Deno.test({
  name: "dockerRun: throws on non-zero exit",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    let threw = false;
    try {
      await dockerRun({
        image: TEST_IMAGE,
        args: [],
        envVars: {},
        command: ["false"],
        interactive: false,
      });
    } catch (e) {
      threw = true;
      assertEquals(
        (e as Error).message.includes("docker run exited with code"),
        true,
      );
    }
    assertEquals(threw, true);
  },
});

Deno.test({
  name: "dockerRun: interactive mode without TTY uses -i only",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    await dockerRun({
      image: TEST_IMAGE,
      args: [],
      envVars: {},
      command: ["true"],
      interactive: true,
    });
  },
});

// --- dockerNetwork ---

Deno.test({
  name: "dockerNetwork: create, connect, remove",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const networkName = `${PREFIX}-net`;
    const containerName = `${PREFIX}-net-container`;
    try {
      await dockerNetworkCreate(networkName);

      await startLongRunningContainer(containerName);

      await dockerNetworkConnect(networkName, containerName);
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await dockerNetworkRemove(networkName).catch(() => {});
    }
  },
});

Deno.test({
  name: "dockerNetworkConnect: supports aliases",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const networkName = `${PREFIX}-net-alias`;
    const containerName = `${PREFIX}-net-alias-container`;
    try {
      await dockerNetworkCreate(networkName);
      await startLongRunningContainer(containerName);

      await dockerNetworkConnect(networkName, containerName, {
        aliases: ["svc-alias", "svc-alt"],
      });

      const inspected = await inspectDockerObject("inspect", containerName) as {
        NetworkSettings?: {
          Networks?: Record<
            string,
            { Aliases?: string[]; DNSNames?: string[] }
          >;
        };
      };
      const network = inspected.NetworkSettings?.Networks?.[networkName];

      assertEquals(Boolean(network), true);
      assertEquals(network?.Aliases?.includes("svc-alias"), true);
      assertEquals(network?.Aliases?.includes("svc-alt"), true);
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await dockerNetworkRemove(networkName).catch(() => {});
    }
  },
});

// --- dockerRemoveImage ---

Deno.test({
  name: "dockerRemoveImage: removes a tagged image",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const tag = `${PREFIX}-rmi-test`;
    const tmpDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${tmpDir}/Dockerfile`, "FROM alpine:latest\n");
      await dockerBuild(tmpDir, tag);

      const beforeExists = await dockerImageExists(tag);
      assertEquals(beforeExists, true);

      await dockerRemoveImage(tag);

      const afterExists = await dockerImageExists(tag);
      assertEquals(afterExists, false);
    } finally {
      await dockerRemoveImage(tag, { force: true }).catch(() => {});
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

// --- dockerVolumeRemove ---

Deno.test({
  name: "dockerVolumeRemove: removes a volume",
  ignore: !DOCKER_DAEMON_AVAILABLE,
  async fn() {
    const volumeName = `${PREFIX}-vol`;
    const cmd = new Deno.Command("docker", {
      args: ["volume", "create", volumeName],
      stdout: "null",
      stderr: "null",
    });
    await cmd.output();

    await dockerVolumeRemove(volumeName);
    const inspectCmd = new Deno.Command("docker", {
      args: ["volume", "inspect", volumeName],
      stdout: "null",
      stderr: "null",
    });
    const result = await inspectCmd.output();
    assertEquals(result.success, false);
  },
});

// --- runInteractiveCommand: SIGINT ---

Deno.test("runInteractiveCommand: SIGINT を静かな割り込みとして扱う", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-interrupt-" });
  const script = `${dir}/wait.sh`;
  const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  try {
    await Deno.writeTextFile(
      script,
      `#!/usr/bin/env bash
trap 'exit 130' INT
while true; do
  sleep 1
done
`,
    );
    await Deno.chmod(script, 0o755);
    const promise = runInteractiveCommand(script, [], {
      stdin: "null",
      stdout: "null",
      stderr: "null",
      signalTrap: {
        add(signal, handler) {
          handlers.set(signal, handler);
        },
        remove(signal) {
          handlers.delete(signal);
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    handlers.get("SIGINT")?.();
    await assertRejects(
      () => promise,
      InterruptedCommandError,
      "interrupted",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
