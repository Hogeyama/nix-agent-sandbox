import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUnixServer, type Server } from "../lib/unix_socket.ts";
import {
  type GatewayTestHarness,
  resolveGatewayTestArtifacts,
  startGatewayTestHarness,
} from "./gateway_test_harness.ts";

const artifacts = await resolveGatewayTestArtifacts();
const catPath = Bun.which("cat");

async function isDockerAvailable(): Promise<boolean> {
  try {
    return (
      (await Bun.spawn(["docker", "info"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited) === 0
    );
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();
const dockerProofAvailable = Boolean(
  dockerAvailable && artifacts.clientPath && artifacts.gatewayPath && catPath,
);

interface DockerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runDocker(args: readonly string[]): Promise<DockerResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function startControlSocket(rootDir: string): Promise<{
  readonly path: string;
  readonly server: Server;
}> {
  const controlDir = path.join(rootDir, "control");
  const controlPath = path.join(controlDir, "control.sock");
  await mkdir(controlDir, { recursive: true });
  const server = await createUnixServer(controlPath, (socket) => {
    socket.destroy();
  });
  return { path: controlPath, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test.skipIf(!dockerProofAvailable)(
  "hostexec gateway passes a container stdin FD through only the external socket mount",
  async () => {
    let harness: GatewayTestHarness | null = null;
    let controlServer: Server | null = null;
    let containerName: string | null = null;
    let bodyError: unknown;
    try {
      const testHarness = await startGatewayTestHarness({
        artifacts,
        // DinD can bind-mount only its explicitly shared temp volume; regular
        // host Docker uses the system temp directory as usual.
        tempDir: process.env.NAS_DIND_SHARED_TMP ?? tmpdir(),
        decide: () => ({
          type: "start" as const,
          spec: {
            argv0: catPath!,
            args: [],
            cwd: "/",
            env: { PATH: process.env.PATH ?? "" },
          },
        }),
      });
      harness = testHarness;
      const control = await startControlSocket(testHarness.rootDir);
      controlServer = control.server;
      containerName = `nas-hostexec-gateway-${crypto.randomUUID()}`;

      const externalMount = "/run/nas-hostexec";
      const clientMount = "/opt/nas/hostexec/libexec/nas-hostexec-client";
      const wrapperDir = "/tmp/nas-hostexec-wrapper";
      const wrapper = `${wrapperDir}/nas-hostexec-client-backed-cat`;
      const externalSocket = `${externalMount}/external.sock`;
      const containerScript = [
        "set -eu",
        `mkdir -p ${shellQuote(wrapperDir)}`,
        `ln -s ${shellQuote(clientMount)} ${shellQuote(wrapper)}`,
        // The two host-only endpoints exist on the host, so this also proves
        // the container has not received their parent directories indirectly.
        `test ! -e ${shellQuote(testHarness.internalSocketPath)}`,
        `test ! -e ${shellQuote(control.path)}`,
        `printf payload | ${shellQuote(wrapper)}`,
      ].join("\n");
      const create = await runDocker([
        "create",
        "--name",
        containerName,
        "--network",
        "none",
        "--mount",
        `type=bind,src=${testHarness.externalSocketDir},dst=${externalMount},readonly`,
        "--mount",
        `type=bind,src=${artifacts.clientPath!},dst=${clientMount},readonly`,
        "-e",
        `NAS_HOSTEXEC_SOCKET=${externalSocket}`,
        "-e",
        "NAS_HOSTEXEC_SESSION_ID=test-session",
        "-e",
        `NAS_HOSTEXEC_WRAPPER_DIR=${wrapperDir}`,
        "alpine:3.20",
        "/bin/sh",
        "-ceu",
        containerScript,
      ]);
      expect(create.exitCode).toBe(0);

      const inspected = await runDocker([
        "inspect",
        "--format",
        "{{json .Mounts}}",
        containerName,
      ]);
      expect(inspected.exitCode).toBe(0);
      const mounts = JSON.parse(inspected.stdout) as Array<{
        readonly Source: string;
        readonly Destination: string;
      }>;
      expect(mounts).toHaveLength(2);
      expect(
        mounts.map(({ Source, Destination }) => ({ Source, Destination })),
      ).toEqual(
        expect.arrayContaining([
          {
            Source: testHarness.externalSocketDir,
            Destination: externalMount,
          },
          { Source: artifacts.clientPath!, Destination: clientMount },
        ]),
      );
      expect(
        mounts.some(
          ({ Source }) =>
            Source === path.dirname(testHarness.internalSocketPath) ||
            Source === path.dirname(control.path),
        ),
      ).toBe(false);

      const started = await runDocker(["start", "-a", containerName]);
      expect(started.exitCode).toBe(0);
      expect(started.stdout).toBe("payload");
      expect(started.stderr).toBe("");
      expect(testHarness.requests).toHaveLength(1);
      expect(testHarness.requests[0]?.stdinMode).toBe("fd");
    } catch (error) {
      bodyError = error;
    } finally {
      let cleanupError: unknown;
      try {
        if (containerName) {
          const removed = await runDocker(["rm", "-f", containerName]);
          // A failed `create` can still have reached the daemon before its
          // client reports an error. Always attempt removal once the name is
          // allocated; preserve the primary assertion failure if there was
          // one, but never leave a successful test's container behind.
          if (removed.exitCode !== 0 && !bodyError) {
            cleanupError = new Error(
              `docker rm failed (${removed.exitCode}): ${removed.stderr}`,
            );
          }
        }
      } catch (error) {
        cleanupError = error;
      }
      try {
        if (controlServer) await closeServer(controlServer);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (harness) await harness.close();
      } catch (error) {
        cleanupError ??= error;
      }
      if (!bodyError && cleanupError) bodyError = cleanupError;
    }
    if (bodyError) throw bodyError;
  },
);

if (dockerAvailable) {
  test("hostexec gateway Docker proof: Docker is available", () => {
    expect(dockerAvailable).toBe(true);
  });
} else {
  test.skip("hostexec gateway Docker proof skipped (Docker is unavailable)", () => {});
}

if (artifacts.gatewayPath !== null) {
  test("hostexec gateway Docker proof: gateway artifact is available", () => {
    expect(artifacts.gatewayPath).not.toBeNull();
  });
} else {
  test.skip("hostexec gateway Docker proof skipped (gateway artifact unavailable: cd src/hostexec/intercept && zig build)", () => {});
}
