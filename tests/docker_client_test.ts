/**
 * E2E tests: Docker クライアントとビルドステージ
 *
 * computeEmbedHash、DockerBuildStage の embed hash チェックロジックなどを検証する。
 * また Docker CLI ラッパー関数のインテグレーションテストを含む。
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { computeEmbedHash } from "../src/docker/client.ts";
import {
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
} from "../src/docker/client.ts";

// --- computeEmbedHash ---

Deno.test("computeEmbedHash: returns consistent hash", async () => {
  const hash1 = await computeEmbedHash();
  const hash2 = await computeEmbedHash();
  assertEquals(hash1, hash2);
});

Deno.test("computeEmbedHash: returns valid SHA-256 hex string", async () => {
  const hash = await computeEmbedHash();
  assertEquals(hash.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
});

// --- embed hash は全埋め込みファイルから計算される ---

Deno.test("computeEmbedHash: includes all embedded files", async () => {
  // ハッシュが embed/ と envoy/ の埋め込みファイルから計算されることを検証
  // 各ファイルの内容を読み取って手動でハッシュを計算し、computeEmbedHash と比較
  const parts: string[] = [];
  for (
    const [baseUrl, files] of [
      [
        new URL("../src/docker/embed/", import.meta.url),
        ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"],
      ],
      [
        new URL("../src/docker/envoy/", import.meta.url),
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
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const actual = await computeEmbedHash();
  assertEquals(actual, expected);
});

// ============================================================
// Docker CLI ラッパー インテグレーションテスト
// ============================================================

const TEST_IMAGE = "alpine:latest";
const PREFIX = "nas-test-" + Date.now();
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

function skipWithoutDockerDaemon(testName: string): boolean {
  if (DOCKER_DAEMON_AVAILABLE) {
    return false;
  }
  console.log(`[skip] ${testName}: docker daemon unavailable`);
  return true;
}

// --- dockerImageExists ---

Deno.test("dockerImageExists: returns true for existing image", async () => {
  if (
    skipWithoutDockerDaemon(
      "dockerImageExists: returns true for existing image",
    )
  ) {
    return;
  }
  // alpine を pull しておく
  const cmd = new Deno.Command("docker", {
    args: ["pull", "-q", TEST_IMAGE],
    stdout: "null",
    stderr: "null",
  });
  await cmd.output();

  const exists = await dockerImageExists(TEST_IMAGE);
  assertEquals(exists, true);
});

Deno.test("dockerImageExists: returns false for non-existing image", async () => {
  const exists = await dockerImageExists("no-such-image-xyz:never");
  assertEquals(exists, false);
});

// --- getImageLabel ---

Deno.test("getImageLabel: returns null for non-existing image", async () => {
  const label = await getImageLabel("no-such-image-xyz:never", "foo");
  assertEquals(label, null);
});

Deno.test("getImageLabel: returns null for non-existing label", async () => {
  const label = await getImageLabel(TEST_IMAGE, "no.such.label.xyz");
  assertEquals(label, null);
});

// --- dockerBuild with labels ---

Deno.test("dockerBuild: builds image with labels and getImageLabel reads them", async () => {
  if (
    skipWithoutDockerDaemon(
      "dockerBuild: builds image with labels and getImageLabel reads them",
    )
  ) {
    return;
  }
  const tag = `${PREFIX}-build-label`;
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/Dockerfile`, "FROM alpine:latest\n");
    await dockerBuild(tmpDir, tag, { "test.label": "hello-nas" });

    const labelValue = await getImageLabel(tag, "test.label");
    assertEquals(labelValue, "hello-nas");
  } finally {
    // cleanup
    await dockerRemoveImage(tag, { force: true }).catch(() => {});
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ヘルパー: コンテナをデタッチモードで起動 (sleep で生存させる)
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

// --- dockerRunDetached ---

Deno.test("dockerRunDetached: starts container in detached mode", async () => {
  if (
    skipWithoutDockerDaemon(
      "dockerRunDetached: starts container in detached mode",
    )
  ) {
    return;
  }
  const containerName = `${PREFIX}-detached`;
  try {
    await dockerRunDetached({
      name: containerName,
      image: TEST_IMAGE,
      args: [],
      envVars: { "TEST_VAR": "detached_value" },
    });
    // alpine のデフォルト CMD は /bin/sh で即終了するが、コンテナ自体は作成される
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
});

Deno.test("dockerRunDetached: supports network, mounts, ports, labels, entrypoint, command", async () => {
  if (
    skipWithoutDockerDaemon(
      "dockerRunDetached: supports network, mounts, ports, labels, entrypoint, command",
    )
  ) {
    return;
  }
  const networkName = `${PREFIX}-detached-net`;
  const containerName = `${PREFIX}-detached-extended`;
  const tmpDir = await Deno.makeTempDir();
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
});

// --- dockerIsRunning / dockerExec / dockerLogs / dockerStop / dockerRm ---

Deno.test("container lifecycle: isRunning, exec, logs, stop, rm", async () => {
  if (
    skipWithoutDockerDaemon(
      "container lifecycle: isRunning, exec, logs, stop, rm",
    )
  ) {
    return;
  }
  const containerName = `${PREFIX}-lifecycle`;
  try {
    await startLongRunningContainer(containerName, {
      "TEST_VAR": "test_value",
    });

    // isRunning: true
    const running = await dockerIsRunning(containerName);
    assertEquals(running, true);

    // exec: コマンド実行
    const execResult = await dockerExec(containerName, ["echo", "hello"]);
    assertEquals(execResult.code, 0);
    assertEquals(execResult.stdout, "hello");

    // exec: 環境変数が渡されている
    const envResult = await dockerExec(containerName, [
      "sh",
      "-c",
      "echo $TEST_VAR",
    ]);
    assertEquals(envResult.code, 0);
    assertEquals(envResult.stdout, "test_value");

    // exec with user option
    const userResult = await dockerExec(
      containerName,
      ["id", "-u"],
      { user: "root" },
    );
    assertEquals(userResult.code, 0);
    assertEquals(userResult.stdout, "0");

    // logs
    const logs = await dockerLogs(containerName);
    assertEquals(typeof logs, "string");

    // logs with tail
    const tailLogs = await dockerLogs(containerName, { tail: 1 });
    assertEquals(typeof tailLogs, "string");

    // stop
    await dockerStop(containerName, { timeoutSeconds: 0 });

    // isRunning: false after stop
    const stoppedRunning = await dockerIsRunning(containerName);
    assertEquals(stoppedRunning, false);

    // rm
    await dockerRm(containerName);
  } catch (e) {
    // cleanup on failure
    await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
    await dockerRm(containerName).catch(() => {});
    throw e;
  }
});

// --- dockerIsRunning: non-existing container ---

Deno.test("dockerIsRunning: returns false for non-existing container", async () => {
  const result = await dockerIsRunning("no-such-container-xyz");
  assertEquals(result, false);
});

// --- dockerExec: failing command ---

Deno.test("dockerExec: returns non-zero code for failing command", async () => {
  if (
    skipWithoutDockerDaemon(
      "dockerExec: returns non-zero code for failing command",
    )
  ) {
    return;
  }
  const containerName = `${PREFIX}-exec-fail`;
  try {
    await startLongRunningContainer(containerName);

    const result = await dockerExec(containerName, ["false"]);
    assertEquals(result.code !== 0, true);
  } finally {
    await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
    await dockerRm(containerName).catch(() => {});
  }
});

// --- dockerLogs: non-existing container ---

Deno.test("dockerLogs: returns fallback for non-existing container", async () => {
  const logs = await dockerLogs("no-such-container-xyz");
  assertEquals(logs, "(failed to retrieve container logs)");
});

// --- dockerRun: non-interactive ---

Deno.test("dockerRun: runs non-interactive command successfully", async () => {
  if (
    skipWithoutDockerDaemon(
      "dockerRun: runs non-interactive command successfully",
    )
  ) {
    return;
  }
  await dockerRun({
    image: TEST_IMAGE,
    args: [],
    envVars: { "GREETING": "world" },
    command: ["sh", "-c", "echo hello $GREETING"],
    interactive: false,
  });
  // no error = success
});

Deno.test("dockerRun: throws on non-zero exit", async () => {
  await assertRejects(
    () =>
      dockerRun({
        image: TEST_IMAGE,
        args: [],
        envVars: {},
        command: ["false"],
        interactive: false,
      }),
    Error,
    "docker run exited with code",
  );
});

Deno.test("dockerRun: interactive mode without TTY uses -i only", async () => {
  if (
    skipWithoutDockerDaemon(
      "dockerRun: interactive mode without TTY uses -i only",
    )
  ) {
    return;
  }
  // テスト環境は非 TTY なので -i のみが付く
  await dockerRun({
    image: TEST_IMAGE,
    args: [],
    envVars: {},
    command: ["true"],
    interactive: true,
  });
  // no error = success
});

// --- dockerNetwork ---

Deno.test("dockerNetwork: create, connect, remove", async () => {
  if (skipWithoutDockerDaemon("dockerNetwork: create, connect, remove")) {
    return;
  }
  const networkName = `${PREFIX}-net`;
  const containerName = `${PREFIX}-net-container`;
  try {
    await dockerNetworkCreate(networkName);

    // コンテナを起動してネットワークに接続
    await startLongRunningContainer(containerName);

    await dockerNetworkConnect(networkName, containerName);
    // 接続成功 = エラーなし
  } finally {
    await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
    await dockerRm(containerName).catch(() => {});
    await dockerNetworkRemove(networkName).catch(() => {});
  }
});

Deno.test("dockerNetworkConnect: supports aliases", async () => {
  if (skipWithoutDockerDaemon("dockerNetworkConnect: supports aliases")) {
    return;
  }
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
});

// --- dockerRemoveImage ---

Deno.test("dockerRemoveImage: removes a tagged image", async () => {
  if (skipWithoutDockerDaemon("dockerRemoveImage: removes a tagged image")) {
    return;
  }
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
});

// --- dockerVolumeRemove ---

Deno.test("dockerVolumeRemove: removes a volume", async () => {
  if (skipWithoutDockerDaemon("dockerVolumeRemove: removes a volume")) {
    return;
  }
  const volumeName = `${PREFIX}-vol`;
  // create volume first
  const cmd = new Deno.Command("docker", {
    args: ["volume", "create", volumeName],
    stdout: "null",
    stderr: "null",
  });
  await cmd.output();

  await dockerVolumeRemove(volumeName);
  // verify it's gone
  const inspectCmd = new Deno.Command("docker", {
    args: ["volume", "inspect", volumeName],
    stdout: "null",
    stderr: "null",
  });
  const result = await inspectCmd.output();
  assertEquals(result.success, false);
});
