import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import {
  dockerExec,
  dockerExecDetached,
  dockerRm,
  dockerRunDetached,
  dockerStop,
} from "../../docker/client.ts";
import { startPortBindBroker } from "../../network/port_bind_broker.ts";
import {
  brokerSocketPath,
  relayScriptPath,
  relaySocketPath,
  resolvePortsRuntimePaths,
} from "../../network/port_bind_registry.ts";
import {
  type RelayGateway,
  startRelayGateway,
} from "../../network/port_bind_relay.ts";
import { DockerServiceLive } from "../../services/docker.ts";
import { FsServiceLive } from "../../services/fs.ts";
import {
  createDockerBuildStage,
  DockerBuildServiceLive,
  resolveBuildProbes,
} from "../docker_build.ts";
import { CONTAINER_RELAY_SCRIPT, CONTAINER_RELAY_SOCKET } from "./stage.ts";

const SHARED_TMP = process.env.NAS_DIND_SHARED_TMP;
const canBindMount = SHARED_TMP !== undefined || !process.env.DOCKER_HOST;
const dockerAvailable = (() => {
  try {
    return Bun.spawnSync(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).success;
  } catch {
    return false;
  }
})();
async function makeDockerBindableTempDir(): Promise<string> {
  const dir = path.join(
    SHARED_TMP ?? tmpdir(),
    `nas-port-bind-${crypto.randomUUID()}`,
  );
  await mkdir(dir, { recursive: true });
  if (SHARED_TMP) await chmod(dir, 0o1777);
  return dir;
}

async function ensureImage(): Promise<void> {
  const imageName = "nas-sandbox";
  const stage = createDockerBuildStage(await resolveBuildProbes(imageName));
  await Effect.runPromise(
    Effect.scoped(
      stage
        .run({ workspace: { workDir: "/tmp", imageName } })
        .pipe(
          Effect.provide(
            DockerBuildServiceLive.pipe(
              Layer.provide(Layer.merge(FsServiceLive, DockerServiceLive)),
            ),
          ),
        ),
    ),
  );
}

async function waitForRelay(gateway: RelayGateway): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!gateway.isRelayConnected()) {
    if (Date.now() >= deadline) throw new Error("relay did not connect");
    await Bun.sleep(25);
  }
}

test.skipIf(!dockerAvailable || !canBindMount)(
  "binds a host port to a non-root relay in the container",
  async () => {
    const containerName = `nas-port-bind-${crypto.randomUUID()}`;
    let runtimeDir: string | undefined;
    let gateway: RelayGateway | undefined;
    let broker: Awaited<ReturnType<typeof startPortBindBroker>> | undefined;

    try {
      await ensureImage();
      runtimeDir = await makeDockerBindableTempDir();
      const paths = await resolvePortsRuntimePaths(runtimeDir);
      const socketPath = relaySocketPath(paths, containerName);
      const scriptPath = relayScriptPath(paths, containerName);
      await mkdir(path.dirname(scriptPath), { recursive: true });
      await copyFile(
        new URL("../../docker/embed/port-relay.mjs", import.meta.url),
        scriptPath,
      );
      gateway = await startRelayGateway({
        socketPath,
        ensureRelay: async () =>
          gateway?.isRelayConnected() ? "ready" : "unreachable",
      });
      broker = await startPortBindBroker({
        controlSocketPath: brokerSocketPath(paths, containerName),
        gateway,
        persist: async () => {},
      });

      await dockerRunDetached({
        name: containerName,
        image: "nas-sandbox:latest",
        args: [],
        envVars: {},
        mounts: [
          { source: socketPath, target: CONTAINER_RELAY_SOCKET, mode: "ro" },
          { source: scriptPath, target: CONTAINER_RELAY_SCRIPT, mode: "ro" },
        ],
        entrypoint: "/usr/local/bin/bun",
        command: [
          "-e",
          'Bun.serve({ hostname: "127.0.0.1", port: 3000, fetch() { return new Response("from-container"); } }); await new Promise(() => {});',
        ],
      });
      const relayStart = await dockerExecDetached(
        containerName,
        ["/usr/local/bin/bun", CONTAINER_RELAY_SCRIPT],
        {
          user: "1000",
          env: { NAS_PORT_RELAY_SOCKET: CONTAINER_RELAY_SOCKET },
        },
      );
      if (relayStart.code !== 0) {
        throw new Error(`relay failed to start: ${relayStart.stderr}`);
      }
      await waitForRelay(gateway);

      const targetDeadline = Date.now() + 5_000;
      while ((await gateway.probe(3000)) !== "ok") {
        if (Date.now() >= targetDeadline) {
          throw new Error("container server did not become ready");
        }
        await Bun.sleep(25);
      }

      const binding = await broker.bind({ containerPort: 3000, hostPort: 0 });
      const response = await fetch(`http://127.0.0.1:${binding.hostPort}`);
      expect(await response.text()).toEqual("from-container");

      const unlink = await dockerExec(
        containerName,
        ["rm", CONTAINER_RELAY_SOCKET],
        { user: "0" },
      );
      expect(unlink.code).not.toEqual(0);

      const nonRootConnect = await dockerExec(
        containerName,
        [
          "/usr/local/bin/bun",
          "-e",
          `import { connect } from "node:net"; const socket = connect({ path: "${CONTAINER_RELAY_SOCKET}" }); socket.on("connect", () => socket.end()); socket.on("error", () => process.exit(1));`,
        ],
        { user: "1000" },
      );
      expect(nonRootConnect.code).toEqual(0);
    } finally {
      await broker?.close().catch(() => {});
      await gateway?.close().catch(() => {});
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      if (runtimeDir) {
        await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  },
  120_000,
);
