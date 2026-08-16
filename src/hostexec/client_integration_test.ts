import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createUnixServer,
  readJsonLine,
  type Server,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import { buildInterceptArtifactsForDev } from "./intercept_dev_build.ts";
import { resolveHostExecClientPath } from "./intercept_path.ts";
import type { ExecuteRequest } from "./types.ts";

/**
 * Integration tests for `nas-hostexec-client`, the standalone binary the
 * wrapper symlinks point at. The LD_PRELOAD sibling is covered by
 * `intercept_integration_test.ts`; both share `protocol.zig`, so what is
 * exercised here is the part that is only in the executable — being reached
 * through a symlink, and the PATH fallback.
 */

/**
 * Build first, then resolve: the client binary is the only place this
 * behaviour is observable, and a missing artifact must show up as a skip
 * rather than a suite that passes without testing anything.
 */
await buildInterceptArtifactsForDev();
const clientPath = await resolveHostExecClientPath();

interface MockResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Answer `fallback` instead of `result`, as the broker does when no rule matches. */
  fallback?: boolean;
  /** Answer `error`, as the broker does for a denied or non-verifying command. */
  error?: string;
}

interface MockBroker {
  server: Server;
  /** Requests received so far, in arrival order. */
  requests: ExecuteRequest[];
}

async function startMockBroker(
  socketPath: string,
  handler: (request: ExecuteRequest) => MockResponse,
): Promise<MockBroker> {
  const requests: ExecuteRequest[] = [];
  const server = await createUnixServer(socketPath, async (socket) => {
    try {
      const line = await readJsonLine(socket);
      if (!line) return;
      const request = JSON.parse(line) as ExecuteRequest;
      requests.push(request);
      const response = handler(request);
      if (response.fallback) {
        await writeJsonLine(socket, {
          type: "fallback",
          requestId: request.requestId,
        });
        return;
      }
      if (response.error) {
        await writeJsonLine(socket, {
          type: "error",
          requestId: request.requestId,
          message: response.error,
        });
        return;
      }
      for (const [fd, data] of [
        [1, response.stdout],
        [2, response.stderr],
      ] as const) {
        if (!data) continue;
        await writeJsonLine(socket, {
          type: "chunk",
          requestId: request.requestId,
          fd,
          data: Buffer.from(data).toString("base64"),
        });
      }
      await writeJsonLine(socket, {
        type: "result",
        requestId: request.requestId,
        exitCode: response.exitCode ?? 0,
      });
    } catch (err) {
      console.error("mock broker handler error:", err);
    } finally {
      socket.end();
    }
  });
  return { server, requests };
}

/**
 * Lay out the container-side directory structure: a wrapper dir holding one
 * symlink per intercepted command name, all pointing at the client binary, and
 * a second dir further along PATH holding the real binaries.
 */
async function setupWrapperDir(
  tmp: string,
  clientPath: string,
  commands: string[],
): Promise<{ wrapperDir: string; realDir: string; pathEnv: string }> {
  const wrapperDir = path.join(tmp, "wrapper-bin");
  const realDir = path.join(tmp, "real-bin");
  await mkdir(wrapperDir, { recursive: true });
  await mkdir(realDir, { recursive: true });
  for (const command of commands) {
    await symlink(clientPath, path.join(wrapperDir, command));
  }
  return { wrapperDir, realDir, pathEnv: `${wrapperDir}:${realDir}` };
}

/**
 * Absolute path of a real `cat`, for fake binaries that need to do something
 * observable with stdin. `/bin/cat` does not exist on every host this test runs
 * on (NixOS), so it cannot be hardcoded.
 */
const realCat = Bun.which("cat");

async function writeRealBinary(
  realDir: string,
  name: string,
  script: string,
): Promise<void> {
  const target = path.join(realDir, name);
  await writeFile(target, script);
  await chmod(target, 0o755);
}

async function runCommand(
  command: string[],
  opts: {
    /** `null` omits the broker env to exercise fail-closed configuration. */
    socketPath: string | null;
    /** Exercise a partially stripped broker environment. */
    omitSessionId?: boolean;
    pathEnv: string;
    wrapperDir: string;
    cwd: string;
    stdin?: string;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(command, {
    cwd: opts.cwd,
    env: {
      PATH: opts.pathEnv,
      NAS_HOSTEXEC_WRAPPER_DIR: opts.wrapperDir,
      ...(opts.socketPath === null
        ? {}
        : {
            NAS_HOSTEXEC_SOCKET: opts.socketPath,
            ...(opts.omitSessionId
              ? {}
              : { NAS_HOSTEXEC_SESSION_ID: "test-session" }),
          }),
    },
    // Default to a closed stdin: the client waits for a first byte on any
    // readable fd 0, and a pipe nobody writes to would cost that wait in every
    // test that is not about stdin.
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
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

test.skipIf(!clientPath)(
  "hostexec client: forwards the command to the broker and relays its output",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const { wrapperDir, pathEnv } = await setupWrapperDir(tmp, clientPath!, [
        "git",
      ]);
      const broker = await startMockBroker(socketPath, () => ({
        stdout: "hello from broker",
        stderr: "some error output",
        exitCode: 3,
      }));

      try {
        const result = await runCommand(["git", "status", "--short"], {
          socketPath,
          pathEnv,
          wrapperDir,
          cwd: tmp,
        });

        expect(result.exitCode).toBe(3);
        expect(result.stdout).toBe("hello from broker");
        expect(result.stderr).toContain("some error output");

        expect(broker.requests.length).toBe(1);
        const request = broker.requests[0];
        // argv0 is the symlink as invoked; the broker takes the basename for
        // bare-command rules.
        expect(path.basename(request.argv0)).toBe("git");
        expect(request.args).toEqual(["status", "--short"]);
        expect(request.sessionId).toBe("test-session");
        expect(request.stdinMode).toBe("none");
      } finally {
        broker.server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!clientPath)(
  "hostexec client: forwards stdin to the broker",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const { wrapperDir, pathEnv } = await setupWrapperDir(tmp, clientPath!, [
        "git",
      ]);
      const broker = await startMockBroker(socketPath, () => ({ exitCode: 0 }));

      try {
        const result = await runCommand(["git", "hash-object", "--stdin"], {
          socketPath,
          pathEnv,
          wrapperDir,
          cwd: tmp,
          stdin: "piped input",
        });

        expect(result.exitCode).toBe(0);
        expect(broker.requests.length).toBe(1);
        expect(broker.requests[0].stdinMode).toBe("fd");
      } finally {
        broker.server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!clientPath)(
  "hostexec client: falls back to the real binary further along PATH",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const { wrapperDir, realDir, pathEnv } = await setupWrapperDir(
        tmp,
        clientPath!,
        ["git"],
      );
      // The fallback must reach *this* binary, not loop back into the wrapper
      // symlink that shadows it — even though the symlink resolves to a path
      // outside the wrapper directory.
      await writeRealBinary(
        realDir,
        "git",
        '#!/bin/sh\necho "real git: $*"\nexit 7\n',
      );
      const broker = await startMockBroker(socketPath, () => ({
        fallback: true,
      }));

      try {
        const result = await runCommand(["git", "log", "--oneline"], {
          socketPath,
          pathEnv,
          wrapperDir,
          cwd: tmp,
        });

        expect(result.stdout.trim()).toBe("real git: log --oneline");
        expect(result.exitCode).toBe(7);
        expect(broker.requests.length).toBe(1);
      } finally {
        broker.server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!clientPath)(
  "hostexec client: a denied command fails instead of running locally",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const { wrapperDir, realDir, pathEnv } = await setupWrapperDir(
        tmp,
        clientPath!,
        ["git"],
      );
      // If the denial were treated as "run it locally", this binary would run
      // and the whole point of `approval: deny` would be lost.
      await writeRealBinary(
        realDir,
        "git",
        '#!/bin/sh\necho "SHOULD NOT RUN"\n',
      );
      const broker = await startMockBroker(socketPath, () => ({
        error: "permission denied by hostexec policy",
      }));

      try {
        const result = await runCommand(["git", "push", "--force"], {
          socketPath,
          pathEnv,
          wrapperDir,
          cwd: tmp,
        });

        expect(result.stdout).not.toContain("SHOULD NOT RUN");
        expect(result.exitCode).toBe(1);
        // The broker's reason is the only explanation the user gets.
        expect(result.stderr).toContain("permission denied by hostexec policy");
      } finally {
        broker.server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!clientPath)(
  "hostexec client: says why a fallback was suppressed after consuming stdin",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const { wrapperDir, realDir, pathEnv } = await setupWrapperDir(
        tmp,
        clientPath!,
        ["git"],
      );
      await writeRealBinary(realDir, "git", '#!/bin/sh\necho "real git"\n');
      const broker = await startMockBroker(socketPath, () => ({
        fallback: true,
      }));

      try {
        // Stdin cannot be pushed back, so the local binary must not be run --
        // it would read an empty stdin. That is defensible; dying silently is
        // not.
        const result = await runCommand(["git", "hash-object", "--stdin"], {
          socketPath,
          pathEnv,
          wrapperDir,
          cwd: tmp,
          stdin: "piped input",
        });

        expect(result.stdout).not.toContain("real git");
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("stdin was already consumed");
      } finally {
        broker.server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!clientPath)(
  "hostexec client: an unreachable broker fails closed instead of running locally",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const { wrapperDir, realDir, pathEnv } = await setupWrapperDir(
        tmp,
        clientPath!,
        ["cat"],
      );
      // A local `cat` would echo its stdin -- but the client already drained fd 0
      // into a request that never reached anyone, so running it here would print
      // nothing and exit 0: silent data loss reported as success.
      await writeRealBinary(
        realDir,
        "cat",
        `#!/bin/sh\nexec ${realCat} "$@"\n`,
      );

      const result = await runCommand(["cat"], {
        socketPath: path.join(tmp, "does-not-exist.sock"),
        pathEnv,
        wrapperDir,
        cwd: tmp,
        stdin: "piped input",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("cannot reach the broker");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!clientPath)(
  "hostexec client: missing broker environment fails closed",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const { wrapperDir, realDir, pathEnv } = await setupWrapperDir(
        tmp,
        clientPath!,
        ["cat"],
      );
      await writeRealBinary(
        realDir,
        "cat",
        `#!/bin/sh\nexec ${realCat} "$@"\n`,
      );

      // Reaching this binary means the hostexec wrapper is active. Treating
      // missing routing metadata as "no matching rule" would let a stripped
      // environment bypass the broker and run the local binary.
      const result = await runCommand(["cat"], {
        socketPath: null,
        pathEnv,
        wrapperDir,
        cwd: tmp,
        stdin: "piped input",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("broker environment is incomplete");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!clientPath)(
  "hostexec client: missing session id fails closed",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const { wrapperDir, realDir, pathEnv } = await setupWrapperDir(
        tmp,
        clientPath!,
        ["cat"],
      );
      await writeRealBinary(
        realDir,
        "cat",
        `#!/bin/sh\nexec ${realCat} "$@"\n`,
      );

      const result = await runCommand(["cat"], {
        socketPath: path.join(tmp, "broker.sock"),
        omitSessionId: true,
        pathEnv,
        wrapperDir,
        cwd: tmp,
        stdin: "piped input",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("broker environment is incomplete");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test.skipIf(!clientPath)(
  "hostexec client: reports a missing fallback binary instead of looping",
  async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "nas-hostexec-client-"));
    try {
      const socketPath = path.join(tmp, "broker.sock");
      const { wrapperDir, pathEnv } = await setupWrapperDir(tmp, clientPath!, [
        "git",
      ]);
      // No real `git` anywhere on PATH: the only candidate is the wrapper
      // symlink itself, which must be skipped rather than re-executed.
      const broker = await startMockBroker(socketPath, () => ({
        fallback: true,
      }));

      try {
        const result = await runCommand(["git", "status"], {
          socketPath,
          pathEnv,
          wrapperDir,
          cwd: tmp,
        });

        expect(result.exitCode).toBe(127);
        expect(result.stderr).toContain("fallback binary not found");
        // One request, not one per loop iteration.
        expect(broker.requests.length).toBe(1);
      } finally {
        broker.server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

// バイナリが無いときだけ走る診断。各ケースは skip として数えたうえで、何が
// 欠けていてどう直すかもテスト出力に残す。
test.skipIf(clientPath !== null)(
  "hostexec client tests skipped (binary not built: cd src/hostexec/intercept && zig build)",
  () => {
    expect(clientPath).toBeNull();
  },
);
