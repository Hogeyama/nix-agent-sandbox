import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import {
  dockerExec,
  dockerExecDetached,
  dockerInspectContainer,
  dockerRm,
  dockerRunDetached,
  dockerStop,
} from "../../docker/client.ts";
import { startOtlpReceiver } from "../../history/receiver.ts";
import {
  _closeHistoryDb,
  openHistoryDb,
  upsertInvocation,
} from "../../history/store.ts";
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
/**
 * This test needs the real image, and building it needs the network for
 * `apt-get`. A DinD sidecar's build containers have no route out, so the
 * build dies at the install step; only a host daemon can produce the image.
 */
const imageBuildable = !(
  SHARED_TMP !== undefined && process.env.DOCKER_HOST !== undefined
);
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
    await Bun.sleep(100);
  }
}

async function waitForRelayDisconnect(gateway: RelayGateway): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (gateway.isRelayConnected()) {
    if (Date.now() >= deadline) throw new Error("relay did not disconnect");
    await Bun.sleep(100);
  }
}

async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function exchange(port: number, payload: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const response: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out reading TCP response from ${port}`));
    }, 5_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk: Buffer) => response.push(chunk));
    socket.once("end", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(Buffer.concat(response).toString());
    });
  });
}

async function freeHostPort(...avoid: number[]): Promise<number> {
  let port = avoid[0] ?? 0;
  while (avoid.includes(port)) {
    const server = createServer();
    port = await listen(server);
    await closeServer(server);
  }
  return port;
}

async function freeContainerPort(
  containerName: string,
  avoid: number,
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await dockerExec(containerName, [
      "/usr/local/bin/bun",
      "-e",
      'const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(server.port); server.stop(true);',
    ]);
    const port = Number(result.stdout);
    if (result.code === 0 && Number.isInteger(port) && port !== avoid) {
      return port;
    }
  }
  throw new Error("container did not provide a distinct free port");
}

const ECHO_SERVER =
  'import { createServer } from "node:net"; createServer((socket) => { let request = Buffer.alloc(0); socket.on("data", (chunk) => { request = Buffer.concat([request, chunk]); const newline = request.indexOf(10); if (newline !== -1) socket.end(Buffer.concat([Buffer.from("echo:"), request.subarray(0, newline)])); }); }).listen(Number(process.argv[1]), "127.0.0.1");';

test.skipIf(!dockerAvailable || !canBindMount || !imageBuildable)(
  "adds unequal Local and Remote echo routes without restarting the container",
  async () => {
    const containerName = `nas-port-bind-${crypto.randomUUID()}`;
    let runtimeDir: string | undefined;
    let gateway: RelayGateway | undefined;
    let broker: Awaited<ReturnType<typeof startPortBindBroker>> | undefined;
    let receiver: Awaited<ReturnType<typeof startOtlpReceiver>> | undefined;
    let historyDbPath: string | undefined;
    let relayStarting: Promise<"ready"> | undefined;
    const hostSockets = new Set<Socket>();
    const hostEcho = createServer({ allowHalfOpen: true }, (socket) => {
      hostSockets.add(socket);
      socket.once("close", () => hostSockets.delete(socket));
      let request = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        const newline = request.indexOf(0x0a);
        if (newline !== -1) {
          socket.end(
            Buffer.concat([Buffer.from("echo:"), request.subarray(0, newline)]),
          );
        }
      });
    });

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
      let relayGeneration = 0;
      const startContainerRelay = async (): Promise<"ready"> => {
        if (gateway?.isRelayConnected()) return "ready";
        if (relayStarting) return await relayStarting;
        relayStarting = (async () => {
          relayGeneration += 1;
          const relayStart = await dockerExecDetached(
            containerName,
            [
              "/bin/sh",
              "-c",
              `echo $$ > /tmp/nas-port-relay-${relayGeneration}.pid; exec /usr/local/bin/bun ${CONTAINER_RELAY_SCRIPT}`,
            ],
            {
              user: "1000",
              env: { NAS_PORT_RELAY_SOCKET: CONTAINER_RELAY_SOCKET },
            },
          );
          if (relayStart.code !== 0) {
            throw new Error(`relay failed to start: ${relayStart.stderr}`);
          }
          if (!gateway) throw new Error("gateway was not started");
          await waitForRelay(gateway);
          return "ready" as const;
        })();
        try {
          return await relayStarting;
        } finally {
          relayStarting = undefined;
        }
      };
      gateway = await startRelayGateway({
        socketPath,
        ensureRelay: startContainerRelay,
        reEnsureDelayMs: 30_000,
        onRelayConnected: () => broker?.onRelayConnected(),
        currentForwards: () =>
          broker
            ?.listPortForwards()
            .filter((entry) => entry.direction === "remote") ?? [],
        onForwardState: (port, state, error) =>
          broker?.onForwardState(port, state, error),
      });
      broker = await startPortBindBroker({
        controlSocketPath: brokerSocketPath(paths, containerName),
        gateway,
        persist: async () => {},
      });
      await broker.prepareInitial([]);

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
        command: ["-e", ECHO_SERVER, "3000"],
      });
      const containerId = (await dockerInspectContainer(containerName)).id;

      const targetDeadline = Date.now() + 5_000;
      while ((await gateway.probe(3000)) !== "ok") {
        if (Date.now() >= targetDeadline) {
          throw new Error("container server did not become ready");
        }
        await Bun.sleep(100);
      }

      const localHostPort = await freeHostPort(3000);
      const local = await broker.addPortForward(
        {
          direction: "local",
          containerPort: 3000,
          hostPort: localHostPort,
        },
        "dynamic",
      );
      expect(local.entry).toMatchObject({
        direction: "local",
        containerPort: 3000,
        hostPort: localHostPort,
        state: "active",
      });
      expect(await exchange(localHostPort, "local-bytes")).toEqual(
        "echo:local-bytes",
      );

      const delayedContainerPort = await freeContainerPort(containerName, 3000);
      const delayedHostPort = await freeHostPort(delayedContainerPort);
      const delayed = await broker.addPortForward(
        {
          direction: "local",
          containerPort: delayedContainerPort,
          hostPort: delayedHostPort,
        },
        "dynamic",
      );
      expect(delayed.probe).toBe("no-answer");
      expect(delayed.entry.state).toBe("active");
      const delayedStart = await dockerExecDetached(
        containerName,
        ["/usr/local/bin/bun", "-e", ECHO_SERVER, String(delayedContainerPort)],
        { user: "1000" },
      );
      expect(delayedStart.code).toBe(0);
      const delayedDeadline = Date.now() + 5_000;
      while ((await gateway.probe(delayedContainerPort)) !== "ok") {
        if (Date.now() >= delayedDeadline) {
          throw new Error("delayed container echo did not become ready");
        }
        await Bun.sleep(100);
      }
      expect(await exchange(delayedHostPort, "late-target")).toBe(
        "echo:late-target",
      );

      const hostEchoPort = await listen(hostEcho);
      const remoteContainerPort = await freeContainerPort(
        containerName,
        hostEchoPort,
      );
      const remote = await broker.addPortForward(
        {
          direction: "remote",
          containerPort: remoteContainerPort,
          hostPort: hostEchoPort,
        },
        "dynamic",
      );
      expect(remote.entry).toMatchObject({
        direction: "remote",
        containerPort: remoteContainerPort,
        hostPort: hostEchoPort,
        state: "active",
      });
      expect(
        (
          await broker.addPortForward(
            {
              direction: "remote",
              containerPort: remoteContainerPort,
              hostPort: hostEchoPort,
            },
            "config",
          )
        ).entry.owners,
      ).toEqual(["dynamic", "config"]);
      const remoteExchange = await dockerExec(containerName, [
        "/usr/local/bin/bun",
        "-e",
        'import { connect } from "node:net"; const socket = connect({ host: "127.0.0.1", port: Number(process.argv[1]) }); const chunks = []; socket.once("connect", () => socket.write("remote-bytes\\n")); socket.on("data", (chunk) => chunks.push(chunk)); socket.on("end", () => process.stdout.write(Buffer.concat(chunks))); socket.on("error", () => process.exit(1));',
        String(remoteContainerPort),
      ]);
      expect(remoteExchange).toEqual({ code: 0, stdout: "echo:remote-bytes" });

      await expect(
        broker.addPortForward(
          {
            direction: "remote",
            containerPort: 3000,
            hostPort: hostEchoPort,
          },
          "dynamic",
        ),
      ).rejects.toThrow("container-port-taken");

      expect((await dockerInspectContainer(containerName)).id).toBe(
        containerId,
      );

      const relayPid = await dockerExec(containerName, [
        "/bin/sh",
        "-c",
        `cat /tmp/nas-port-relay-${relayGeneration}.pid`,
      ]);
      expect(relayPid.code).toBe(0);
      expect(
        (await dockerExec(containerName, ["/bin/kill", relayPid.stdout])).code,
      ).toBe(0);
      await waitForRelayDisconnect(gateway);
      expect(
        await broker.removePortForward({
          direction: "remote",
          containerPort: remoteContainerPort,
        }),
      ).toEqual({
        removed: true,
        retainedInternal: false,
        listenerClosed: false,
      });
      await startContainerRelay();
      expect(
        broker
          .listPortForwards()
          .some(
            (entry) =>
              entry.direction === "remote" &&
              entry.containerPort === remoteContainerPort,
          ),
      ).toBe(false);
      const removedDial = await dockerExec(containerName, [
        "/usr/local/bin/bun",
        "-e",
        'import { connect } from "node:net"; const socket = connect({ host: "127.0.0.1", port: Number(process.argv[1]) }); socket.once("connect", () => process.exit(0)); socket.once("error", () => process.exit(1));',
        String(remoteContainerPort),
      ]);
      expect(removedDial.code).not.toBe(0);

      historyDbPath = path.join(runtimeDir, "history.db");
      const historyDb = openHistoryDb({
        path: historyDbPath,
        mode: "readwrite",
      });
      upsertInvocation(historyDb, {
        id: "session-history",
        profile: "default",
        agent: "claude",
        worktreePath: null,
        startedAt: "2026-09-09T00:00:00Z",
        endedAt: null,
        exitReason: null,
      });
      const receiverPort = await freeHostPort(
        3000,
        delayedContainerPort,
        remoteContainerPort,
      );
      receiver = await startOtlpReceiver({
        db: historyDb,
        port: receiverPort,
        fallbackMetadata: { sessionId: "session-history" },
      });
      const receiverSpec = {
        direction: "remote" as const,
        hostPort: receiver.port,
        containerPort: receiver.port,
      };
      await broker.addPortForward(receiverSpec, "internal");
      await broker.addPortForward(receiverSpec, "config");
      expect(await broker.removePortForward(receiverSpec)).toEqual({
        removed: true,
        retainedInternal: true,
        listenerClosed: false,
      });
      expect(broker.listPortForwards()).toContainEqual(
        expect.objectContaining({ ...receiverSpec, owners: ["internal"] }),
      );

      const historyResult = await dockerExec(containerName, [
        "/usr/local/bin/bun",
        "-e",
        `const payload = { resourceLogs: [{ resource: { attributes: [{ key: "nas.session.id", value: { stringValue: "session-history" } }] }, scopeLogs: [{ logRecords: [{ timeUnixNano: "1746057600000000000", attributes: [{ key: "event.name", value: { stringValue: "user_prompt" } }, { key: "session.id", value: { stringValue: "conversation-history" } }, { key: "prompt.id", value: { stringValue: "prompt-history" } }, { key: "event.sequence", value: { intValue: 1 } }] }] }] }] }; const response = await fetch("http://127.0.0.1:${receiver.port}/v1/logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); console.log(response.status);`,
      ]);
      expect(historyResult).toEqual({ code: 0, stdout: "200" });
      expect(
        (
          historyDb
            .query("SELECT COUNT(*) AS count FROM log_records")
            .get() as { count: number }
        ).count,
      ).toBe(1);

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
      for (const socket of hostSockets) socket.destroy();
      await receiver?.close().catch(() => {});
      if (historyDbPath) _closeHistoryDb(historyDbPath);
      await broker?.close().catch(() => {});
      await gateway?.close().catch(() => {});
      await closeServer(hostEcho).catch(() => {});
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      if (runtimeDir) {
        await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  },
  120_000,
);
