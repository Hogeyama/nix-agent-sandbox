import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ProxyService integration test (real Docker, real mitmproxy image).
 *
 * The stock mitmproxy entrypoint maps the `mitmproxy` account onto the
 * uid/gid that owns the mounted cert store via `usermod -g`, which fails
 * when that gid has no /etc/group entry in the image — e.g. a host user
 * whose primary gid is 1001. ensureSharedProxy wraps the entrypoint to
 * create the group first; this test drives the real service against a cert
 * store owned by ids the image does not know.
 */

import { Effect, Layer } from "effect";
import {
  dockerExec,
  dockerLogs,
  dockerRm,
  dockerStop,
} from "../../docker/client.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { DockerServiceLive } from "../../services/docker.ts";
import {
  type EnsureProxyPlan,
  ProxyService,
  ProxyServiceLive,
} from "./proxy_service.ts";

const PROXY_IMAGE = "mitmproxy/mitmproxy:11";
const PROXY_PORT = 8080;

/**
 * An id absent from the image's /etc/passwd and /etc/group, standing in for
 * host accounts like the GitHub Actions runner user (uid/gid 1001).
 */
const FOREIGN_UID = 12345;
const FOREIGN_GID = 12345;

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

// Bind mounts and host-side ownership checks only behave predictably against
// a host-local daemon on Linux.
const RUNNING_ON_HOST_DOCKER =
  !process.env.DOCKER_HOST && process.platform === "linux";
const dockerAvailable = RUNNING_ON_HOST_DOCKER && (await isDockerAvailable());

async function runDocker(args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`docker ${args.join(" ")} exited ${code}: ${stderr}`);
  }
}

/**
 * Generate a CA store owned by FOREIGN_UID:FOREIGN_GID — the same
 * `CertStore.from_store` call CaService makes, but with ids that do not
 * exist in the image. Without this the store lands on the host user's
 * gid and the foreign-gid path the test exists for is never exercised.
 */
async function generateForeignOwnedCa(caCertDir: string): Promise<void> {
  // The container-side user cannot write into a host-owned 0755 dir.
  await chmod(caCertDir, 0o777);
  await runDocker([
    "run",
    "--rm",
    "--user",
    `${FOREIGN_UID}:${FOREIGN_GID}`,
    "-v",
    `${caCertDir}:/home/mitmproxy/.mitmproxy`,
    "--entrypoint",
    "python3",
    PROXY_IMAGE,
    "-c",
    "from mitmproxy.certs import CertStore; CertStore.from_store('/home/mitmproxy/.mitmproxy', 'mitmproxy', 2048)",
  ]);
}

/**
 * ensureSharedProxy resolves once the container is running, which precedes
 * mitmdump actually binding its listener — poll the port itself.
 */
async function waitForProxyTcp(containerName: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await dockerExec(containerName, [
      "python3",
      "-c",
      `import socket; socket.create_connection(("127.0.0.1", ${PROXY_PORT}), 0.5).close()`,
    ]);
    if (result.code === 0) return;
    await Bun.sleep(250);
  }
  const logs = await dockerLogs(containerName);
  throw new Error(
    `${containerName} never listened on ${PROXY_PORT}\n` +
      `--- container logs ---\n${logs}`,
  );
}

test.skipIf(!dockerAvailable)(
  "ensureSharedProxy: proxy serves on 8080 with a cert store owned by ids unknown to the image",
  async () => {
    const containerName = `nas-test-proxy-${crypto.randomUUID()}`;
    const rootDir = await mkdtemp(path.join(tmpdir(), "nas-proxy-integ-"));
    try {
      const runtimeDir = path.join(rootDir, "network");
      const caCertDir = path.join(runtimeDir, "mitmproxy-ca");
      await mkdir(caCertDir, { recursive: true });
      // The service's mitmdump command loads this addon; an empty script is
      // enough — what is under test is the entrypoint, not addon behavior.
      await writeFile(path.join(runtimeDir, "nas_addon.py"), "\n");

      await generateForeignOwnedCa(caCertDir);
      const pem = await stat(path.join(caCertDir, "mitmproxy-ca.pem"));
      expect({ uid: pem.uid, gid: pem.gid }).toEqual({
        uid: FOREIGN_UID,
        gid: FOREIGN_GID,
      });

      const runtimePaths: NetworkRuntimePaths = {
        runtimeDir,
        sessionsDir: path.join(runtimeDir, "sessions"),
        pendingDir: path.join(runtimeDir, "pending"),
        brokersDir: path.join(runtimeDir, "brokers"),
        caCertDir,
        addonScriptPath: path.join(runtimeDir, "nas_addon.py"),
        authzDir: path.join(runtimeDir, "authz"),
      };
      const plan: EnsureProxyPlan = {
        proxyContainerName: containerName,
        proxyImage: PROXY_IMAGE,
        runtimePaths,
        proxyReadyTimeoutMs: 30_000,
        addonHash: "integration-test",
      };

      const layer = Layer.provide(ProxyServiceLive, DockerServiceLive);
      await Effect.runPromise(
        ProxyService.pipe(
          Effect.flatMap((svc) => svc.ensureSharedProxy(plan)),
          Effect.provide(layer),
        ),
      );

      await waitForProxyTcp(containerName);

      // The entrypoint must have created the foreign gid and remapped the
      // account — the daemon ends up running as the cert store's owner.
      const id = await dockerExec(containerName, ["id", "mitmproxy"]);
      expect(id.stdout).toContain(`uid=${FOREIGN_UID}`);
      expect(id.stdout).toContain(`gid=${FOREIGN_GID}`);
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  120_000,
);
