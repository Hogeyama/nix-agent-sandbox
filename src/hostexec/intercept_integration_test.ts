import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createUnixServer,
  readJsonLine,
  type Server,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import { buildInterceptArtifactsForDev } from "./intercept_dev_build.ts";
import { resolveInterceptLibPath } from "./intercept_path.ts";
import type { ExecuteRequest } from "./types.ts";

/**
 * Build first, then resolve: the .so is the only place this behaviour is
 * observable, and a missing artifact must show up as a skip rather than a
 * suite that passes without testing anything.
 */
await buildInterceptArtifactsForDev();
const soPath = await resolveInterceptLibPath();
/** Any binary the intercept list does not name works; `echo` is the smallest. */
const echoPath = Bun.which("echo");

/**
 * Start a mock broker that listens on the given Unix socket and responds
 * to each incoming JSON-line request using the provided handler function.
 *
 * Mirrors the real broker's streaming protocol: stdout/stderr (if any) are
 * sent as base64-encoded `chunk` messages, followed by a final `result`
 * message carrying the exit code.
 */
function startMockBroker(
  socketPath: string,
  handler: (request: ExecuteRequest) => {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    /** Answer `error`, as the broker does for a denied or non-verifying command. */
    error?: string;
  },
): Promise<Server> {
  return createUnixServer(socketPath, async (socket) => {
    try {
      const line = await readJsonLine(socket);
      if (line) {
        const request = JSON.parse(line) as ExecuteRequest;
        const { stdout, stderr, exitCode, error } = handler(request);
        if (error) {
          await writeJsonLine(socket, {
            type: "error",
            requestId: request.requestId,
            message: error,
          });
          return;
        }
        if (stdout) {
          await writeJsonLine(socket, {
            type: "chunk",
            requestId: request.requestId,
            fd: 1,
            data: Buffer.from(stdout).toString("base64"),
          });
        }
        if (stderr) {
          await writeJsonLine(socket, {
            type: "chunk",
            requestId: request.requestId,
            fd: 2,
            data: Buffer.from(stderr).toString("base64"),
          });
        }
        await writeJsonLine(socket, {
          type: "result",
          requestId: request.requestId,
          exitCode: exitCode ?? 0,
        });
      }
    } catch (err) {
      console.error("mock broker handler error:", err);
    } finally {
      socket.end();
    }
  });
}

/**
 * Spawn a child process with LD_PRELOAD pointing to the intercept .so.
 * Returns stdout, stderr, and exit code.
 */
async function spawnWithIntercept(
  soPath: string,
  socketPath: string,
  interceptPaths: string,
  command: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(command, {
    env: {
      ...process.env,
      LD_PRELOAD: soPath,
      NAS_HOSTEXEC_INTERCEPT_PATHS: interceptPaths,
      NAS_HOSTEXEC_SOCKET: socketPath,
      NAS_HOSTEXEC_SESSION_ID: "test-session",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test.skipIf(!soPath)(
  "intercept .so: broker returns exitCode=0 with stdout and stderr",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-integ-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const interceptTarget = path.join(tmp, "intercepted-cmd");

      // Create a dummy executable (real execution should never reach it)
      await writeFile(interceptTarget, "#!/bin/sh\nexit 99\n");
      await chmod(interceptTarget, 0o755);

      const expectedStdout = "hello from broker";
      const expectedStderr = "some error output";

      const server = await startMockBroker(socketPath, () => ({
        stdout: expectedStdout,
        stderr: expectedStderr,
        exitCode: 0,
      }));

      try {
        const result = await spawnWithIntercept(
          soPath!,
          socketPath,
          interceptTarget,
          ["bash", "-c", `exec '${interceptTarget}'`],
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(expectedStdout);
        expect(result.stderr).toContain(expectedStderr);
      } finally {
        server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!soPath)(
  "intercept .so: broker returns non-zero exit code",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-integ-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const interceptTarget = path.join(tmp, "intercepted-cmd");

      await writeFile(interceptTarget, "#!/bin/sh\nexit 99\n");
      await chmod(interceptTarget, 0o755);

      const server = await startMockBroker(socketPath, () => ({
        exitCode: 42,
      }));

      try {
        const result = await spawnWithIntercept(
          soPath!,
          socketPath,
          interceptTarget,
          ["bash", "-c", `exec '${interceptTarget}'`],
        );

        expect(result.exitCode).toBe(42);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      } finally {
        server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!soPath)(
  "intercept .so: a denied command fails instead of running the real binary",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-integ-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const interceptTarget = path.join(tmp, "intercepted-cmd");

      // exit 99 marks the real binary having run. An `error` response is the
      // broker refusing -- policy deny, user deny, failed integrity check -- so
      // executing the command anyway, even locally, would defeat the denial.
      await writeFile(interceptTarget, "#!/bin/sh\nexit 99\n");
      await chmod(interceptTarget, 0o755);

      const server = await startMockBroker(socketPath, () => ({
        error: "permission denied by hostexec policy",
      }));

      try {
        const result = await spawnWithIntercept(
          soPath!,
          socketPath,
          interceptTarget,
          ["bash", "-c", `exec '${interceptTarget}'`],
        );

        expect(result.exitCode).toBe(1);
        expect(result.exitCode).not.toBe(99);
        expect(result.stderr).toContain("permission denied by hostexec policy");
      } finally {
        server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!soPath || !echoPath)(
  "intercept .so: non-intercepted command runs normally",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-integ-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      // interceptTarget is a path that does NOT match any command we run
      const interceptTarget = path.join(tmp, "not-the-command-we-run");

      // Run echo which is NOT in the intercept list
      const result = await spawnWithIntercept(
        soPath!,
        socketPath,
        interceptTarget,
        [echoPath!, "normal-output"],
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("normal-output");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

// ライブラリが無いときだけ走る診断。各ケースは skip として数えたうえで、何が
// 欠けていてどう直すかもテスト出力に残す。
test.skipIf(soPath !== null)(
  "hostexec intercept tests skipped (library not built: cd src/hostexec/intercept && zig build)",
  () => {
    expect(soPath).toBeNull();
  },
);
