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
import { resolveInterceptLibPath } from "./intercept_path.ts";
import type { ExecuteRequest, HostExecBrokerResponse } from "./types.ts";

/**
 * Start a mock broker that listens on the given Unix socket and responds
 * to each incoming JSON-line request using the provided handler function.
 */
function startMockBroker(
  socketPath: string,
  handler: (request: ExecuteRequest) => HostExecBrokerResponse,
): Promise<Server> {
  return createUnixServer(socketPath, async (socket) => {
    try {
      const line = await readJsonLine(socket);
      if (line) {
        const request = JSON.parse(line) as ExecuteRequest;
        const response = handler(request);
        await writeJsonLine(socket, response);
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

test("intercept .so: broker returns exitCode=0 with stdout and stderr", async () => {
  const soPath = await resolveInterceptLibPath();
  if (!soPath) {
    console.warn("Skipping: hostexec_intercept.so not found");
    return;
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-integ-"));
  try {
    const socketPath = path.join(tmp, "broker.sock");
    const interceptTarget = path.join(tmp, "intercepted-cmd");

    // Create a dummy executable (real execution should never reach it)
    await writeFile(interceptTarget, "#!/bin/sh\nexit 99\n");
    await chmod(interceptTarget, 0o755);

    const expectedStdout = "hello from broker";
    const expectedStderr = "some error output";

    const server = await startMockBroker(socketPath, (req) => ({
      type: "result" as const,
      requestId: req.requestId,
      exitCode: 0,
      stdout: Buffer.from(expectedStdout).toString("base64"),
      stderr: Buffer.from(expectedStderr).toString("base64"),
    }));

    try {
      const result = await spawnWithIntercept(
        soPath,
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
});

test("intercept .so: broker returns non-zero exit code", async () => {
  const soPath = await resolveInterceptLibPath();
  if (!soPath) {
    console.warn("Skipping: hostexec_intercept.so not found");
    return;
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-integ-"));
  try {
    const socketPath = path.join(tmp, "broker.sock");
    const interceptTarget = path.join(tmp, "intercepted-cmd");

    await writeFile(interceptTarget, "#!/bin/sh\nexit 99\n");
    await chmod(interceptTarget, 0o755);

    const server = await startMockBroker(socketPath, (req) => ({
      type: "result" as const,
      requestId: req.requestId,
      exitCode: 42,
      stdout: Buffer.from("").toString("base64"),
      stderr: Buffer.from("").toString("base64"),
    }));

    try {
      const result = await spawnWithIntercept(
        soPath,
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
});

test("intercept .so: non-intercepted command runs normally", async () => {
  const soPath = await resolveInterceptLibPath();
  if (!soPath) {
    console.warn("Skipping: hostexec_intercept.so not found");
    return;
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-integ-"));
  try {
    const socketPath = path.join(tmp, "broker.sock");
    // interceptTarget is a path that does NOT match any command we run
    const interceptTarget = path.join(tmp, "not-the-command-we-run");

    // Run /bin/echo which is NOT in the intercept list
    const result = await spawnWithIntercept(
      soPath,
      socketPath,
      interceptTarget,
      ["/bin/echo", "normal-output"],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("normal-output");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
