import { expect, test } from "bun:test";
/**
 * Docker CLI ラッパー integration テスト
 *
 * - computeEmbedHash / envoy template: Docker daemon 不要、ファイル I/O のみ
 * - それ以外: 実 Docker daemon 必要（ignore ガードあり）
 * - unit テスト（Docker 不要・I/O 不要）は client_test.ts を参照
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EMBEDDED_BUILD_ASSET_GROUPS } from "../stages/docker_build.ts";
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
  runInteractiveCommand,
} from "./client.ts";

const TEST_IMAGE = "alpine:latest";
const PREFIX = `nas-test-${Date.now()}`;
const SHARED_TMP = process.env.NAS_DIND_SHARED_TMP;
const DOCKER_HOST = process.env.DOCKER_HOST;
const canBindMount = SHARED_TMP !== undefined || !DOCKER_HOST;
const DOCKER_DAEMON_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).success;
  } catch {
    return false;
  }
})();

async function makeDockerBindableTempDir(prefix: string): Promise<string> {
  const base = SHARED_TMP ?? "/tmp";
  const dir = `${base}/${prefix}${crypto.randomUUID().slice(0, 8)}`;
  await mkdir(dir, { recursive: true });
  if (SHARED_TMP) {
    await chmod(dir, 0o1777);
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
  const exitCode = await Bun.spawn(
    [
      "docker",
      "run",
      "-d",
      "--name",
      name,
      ...envArgs,
      TEST_IMAGE,
      "sleep",
      "300",
    ],
    { stdout: "ignore", stderr: "ignore" },
  ).exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to start container ${name}`);
  }
}

async function inspectDockerObject(
  ...args: string[]
): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${stderrText.trim()}`);
  }

  return JSON.parse(stdoutText)[0];
}

// --- computeEmbedHash / envoy template (Docker daemon 不要) ---

test("computeEmbedHash returns consistent hash", async () => {
  const hash1 = await computeEmbedHash();
  const hash2 = await computeEmbedHash();
  expect(hash1).toEqual(hash2);
  // SHA-256 hex is 64 chars
  expect(hash1.length).toEqual(64);
});

test("computeEmbedHash matches embed and envoy assets", async () => {
  const parts: string[] = [];
  for (const group of EMBEDDED_BUILD_ASSET_GROUPS) {
    for (const name of group.files) {
      parts.push(await readFile(path.join(group.baseDir, name), "utf8"));
    }
  }
  const data = new TextEncoder().encode(parts.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const expected = Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  expect(await computeEmbedHash()).toEqual(expected);
});

test("computeEmbedHash changes compared with legacy hash that omitted local-proxy.mjs", async () => {
  const parts: string[] = [];
  for (const group of EMBEDDED_BUILD_ASSET_GROUPS) {
    for (const name of group.files) {
      if (name === "local-proxy.mjs") {
        continue;
      }
      parts.push(await readFile(path.join(group.baseDir, name), "utf8"));
    }
  }
  const data = new TextEncoder().encode(parts.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const legacyHash = Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  expect(await computeEmbedHash()).not.toEqual(legacyHash);
});

test("envoy template includes required proxy settings", async () => {
  const template = await readFile(
    new URL("./envoy/envoy.template.yaml", import.meta.url),
    "utf8",
  );

  for (const fragment of [
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
  ]) {
    expect(template.includes(fragment)).toEqual(true);
  }
});

// --- dockerImageExists ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerImageExists: returns true for existing image",
  async () => {
    await Bun.spawn(["docker", "pull", "-q", TEST_IMAGE], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;

    const exists = await dockerImageExists(TEST_IMAGE);
    expect(exists).toEqual(true);
  },
);

// --- dockerBuild with labels ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerBuild: builds image with labels and getImageLabel reads them",
  async () => {
    const tag = `${PREFIX}-build-label`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "tmp-"));
    try {
      await writeFile(`${tmpDir}/Dockerfile`, "FROM alpine:latest\n");
      await dockerBuild(tmpDir, tag, { "test.label": "hello-nas" });

      const labelValue = await getImageLabel(tag, "test.label");
      expect(labelValue).toEqual("hello-nas");
    } finally {
      await dockerRemoveImage(tag, { force: true }).catch(() => {});
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// --- dockerRunDetached ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerRunDetached: starts container in detached mode",
  async () => {
    const containerName = `${PREFIX}-detached`;
    try {
      await dockerRunDetached({
        name: containerName,
        image: TEST_IMAGE,
        args: [],
        envVars: { TEST_VAR: "detached_value" },
      });
      const exitCode = await Bun.spawn(["docker", "inspect", containerName], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      expect(exitCode).toEqual(0);
    } finally {
      await dockerRm(containerName).catch(() => {});
    }
  },
);

test.skipIf(!DOCKER_DAEMON_AVAILABLE || !canBindMount)(
  "dockerRunDetached: supports network, mounts, ports, labels, entrypoint, command",
  async () => {
    const networkName = `${PREFIX}-detached-net`;
    const containerName = `${PREFIX}-detached-extended`;
    const tmpDir = await makeDockerBindableTempDir("nas-docker-client-");
    try {
      await writeFile(`${tmpDir}/hello.txt`, "hello");
      await dockerNetworkCreate(networkName);

      await dockerRunDetached({
        name: containerName,
        image: TEST_IMAGE,
        args: [],
        envVars: { TEST_VAR: "detached_value" },
        network: networkName,
        mounts: [`type=bind,src=${tmpDir},dst=/workspace,readonly`],
        publishedPorts: ["127.0.0.1::8080"],
        labels: { "test.label": "extended" },
        entrypoint: "/bin/sh",
        command: ["-c", "sleep 300"],
      });

      const inspected = (await inspectDockerObject(
        "inspect",
        containerName,
      )) as {
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
          Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
        };
      };

      expect(inspected.HostConfig?.NetworkMode).toEqual(networkName);
      expect(inspected.Config?.Entrypoint).toEqual(["/bin/sh"]);
      expect(inspected.Config?.Cmd).toEqual(["-c", "sleep 300"]);
      expect(inspected.Config?.Labels?.["test.label"]).toEqual("extended");
      expect(
        inspected.Config?.Env?.includes("TEST_VAR=detached_value"),
      ).toEqual(true);
      expect(
        inspected.Mounts?.some(
          (mount) =>
            mount.Type === "bind" &&
            mount.Source === tmpDir &&
            mount.Destination === "/workspace" &&
            mount.RW === false,
        ),
      ).toEqual(true);
      expect(
        inspected.NetworkSettings?.Ports?.["8080/tcp"]?.[0]?.HostIp,
      ).toEqual("127.0.0.1");
      expect(
        (inspected.NetworkSettings?.Ports?.["8080/tcp"]?.[0]?.HostPort ?? "")
          .length > 0,
      ).toBeTruthy();
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await dockerNetworkRemove(networkName).catch(() => {});
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// --- dockerIsRunning / dockerExec / dockerLogs / dockerStop / dockerRm ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "container lifecycle: isRunning, exec, logs, stop, rm",
  async () => {
    const containerName = `${PREFIX}-lifecycle`;
    try {
      await startLongRunningContainer(containerName, {
        TEST_VAR: "test_value",
      });

      const running = await dockerIsRunning(containerName);
      expect(running).toEqual(true);

      const execResult = await dockerExec(containerName, ["echo", "hello"]);
      expect(execResult.code).toEqual(0);
      expect(execResult.stdout).toEqual("hello");

      const envResult = await dockerExec(containerName, [
        "sh",
        "-c",
        "echo $TEST_VAR",
      ]);
      expect(envResult.code).toEqual(0);
      expect(envResult.stdout).toEqual("test_value");

      const userResult = await dockerExec(containerName, ["id", "-u"], {
        user: "root",
      });
      expect(userResult.code).toEqual(0);
      expect(userResult.stdout).toEqual("0");

      const logs = await dockerLogs(containerName);
      expect(typeof logs).toEqual("string");

      const tailLogs = await dockerLogs(containerName, { tail: 1 });
      expect(typeof tailLogs).toEqual("string");

      await dockerStop(containerName, { timeoutSeconds: 0 });

      const stoppedRunning = await dockerIsRunning(containerName);
      expect(stoppedRunning).toEqual(false);

      await dockerRm(containerName);
    } catch (e) {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      throw e;
    }
  },
);

// --- dockerExec: failing command ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerExec: returns non-zero code for failing command",
  async () => {
    const containerName = `${PREFIX}-exec-fail`;
    try {
      await startLongRunningContainer(containerName);

      const result = await dockerExec(containerName, ["false"]);
      expect(result.code !== 0).toEqual(true);
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
    }
  },
);

// --- dockerRun: non-interactive ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerRun: runs non-interactive command successfully",
  async () => {
    await dockerRun({
      image: TEST_IMAGE,
      args: [],
      envVars: { GREETING: "world" },
      command: ["sh", "-c", "echo hello $GREETING"],
      interactive: false,
    });
  },
);

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerRun: throws on non-zero exit",
  async () => {
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
      expect(
        (e as Error).message.includes("docker run exited with code"),
      ).toEqual(true);
    }
    expect(threw).toEqual(true);
  },
);

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerRun: interactive mode without TTY uses -i only",
  async () => {
    await dockerRun({
      image: TEST_IMAGE,
      args: [],
      envVars: {},
      command: ["true"],
      interactive: true,
    });
  },
);

// --- dockerNetwork ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerNetwork: create, connect, remove",
  async () => {
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
);

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerNetworkConnect: supports aliases",
  async () => {
    const networkName = `${PREFIX}-net-alias`;
    const containerName = `${PREFIX}-net-alias-container`;
    try {
      await dockerNetworkCreate(networkName);
      await startLongRunningContainer(containerName);

      await dockerNetworkConnect(networkName, containerName, {
        aliases: ["svc-alias", "svc-alt"],
      });

      const inspected = (await inspectDockerObject(
        "inspect",
        containerName,
      )) as {
        NetworkSettings?: {
          Networks?: Record<
            string,
            { Aliases?: string[]; DNSNames?: string[] }
          >;
        };
      };
      const network = inspected.NetworkSettings?.Networks?.[networkName];

      expect(Boolean(network)).toEqual(true);
      expect(network?.Aliases?.includes("svc-alias")).toEqual(true);
      expect(network?.Aliases?.includes("svc-alt")).toEqual(true);
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await dockerNetworkRemove(networkName).catch(() => {});
    }
  },
);

// --- dockerRemoveImage ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerRemoveImage: removes a tagged image",
  async () => {
    const tag = `${PREFIX}-rmi-test`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "tmp-"));
    try {
      await writeFile(`${tmpDir}/Dockerfile`, "FROM alpine:latest\n");
      await dockerBuild(tmpDir, tag);

      const beforeExists = await dockerImageExists(tag);
      expect(beforeExists).toEqual(true);

      await dockerRemoveImage(tag);

      const afterExists = await dockerImageExists(tag);
      expect(afterExists).toEqual(false);
    } finally {
      await dockerRemoveImage(tag, { force: true }).catch(() => {});
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// --- dockerVolumeRemove ---

test.skipIf(!DOCKER_DAEMON_AVAILABLE)(
  "dockerVolumeRemove: removes a volume",
  async () => {
    const volumeName = `${PREFIX}-vol`;
    await Bun.spawn(["docker", "volume", "create", volumeName], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;

    await dockerVolumeRemove(volumeName);
    const exitCode = await Bun.spawn(
      ["docker", "volume", "inspect", volumeName],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
    expect(exitCode).not.toEqual(0);
  },
);

// --- runInteractiveCommand: SIGINT ---

test("runInteractiveCommand: SIGINT を静かな割り込みとして扱う", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-interrupt-"));
  const script = `${dir}/wait.sh`;
  const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  try {
    await writeFile(
      script,
      `#!/usr/bin/env bash
trap 'exit 130' INT
while true; do
  sleep 1
done
`,
    );
    await chmod(script, 0o755);
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
    await expect(promise).rejects.toThrow("interrupted");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
