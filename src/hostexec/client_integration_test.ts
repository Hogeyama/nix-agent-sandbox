import { expect, test } from "bun:test";
import { chmod, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExternalExecuteRequestV2 } from "./gateway_protocol.ts";
import {
  type GatewayDecision,
  type GatewayTestHarness,
  resolveGatewayTestArtifacts,
  startGatewayTestHarness,
} from "./gateway_test_harness.ts";

/**
 * Integration tests for the standalone client.  Every broker-facing case
 * runs through the real gateway: a Node server cannot receive SCM_RIGHTS,
 * so testing the client against one would prove only the old v1 path.
 */
const artifacts = await resolveGatewayTestArtifacts();
const clientGatewayAvailable = Boolean(
  artifacts.clientPath && artifacts.gatewayPath,
);
const realCat = Bun.which("cat") ?? "/bin/cat";

async function linkClient(
  harness: GatewayTestHarness,
  command: string,
): Promise<void> {
  await symlink(
    harness.artifacts.clientPath!,
    path.join(harness.wrapperDir, command),
  );
}

async function writeRealBinary(
  harness: GatewayTestHarness,
  name: string,
  script: string,
): Promise<string> {
  const target = path.join(harness.realDir, name);
  await writeFile(target, script);
  await chmod(target, 0o755);
  return target;
}

function startRealBinary(
  harness: GatewayTestHarness,
  request: ExternalExecuteRequestV2,
  binary: string,
): GatewayDecision {
  return {
    type: "start",
    spec: {
      argv0: binary,
      args: request.args,
      cwd: harness.rootDir,
      env: {
        PATH: `${harness.realDir}:${process.env.PATH ?? ""}`,
      },
    },
  };
}

async function startClientHarness(
  decide: (
    harness: GatewayTestHarness,
    request: ExternalExecuteRequestV2,
  ) => GatewayDecision | Promise<GatewayDecision>,
): Promise<GatewayTestHarness> {
  // The callback is invoked only after the gateway has announced readiness,
  // so the assignment is complete before a test can send a request.
  let harness!: GatewayTestHarness;
  harness = await startGatewayTestHarness({
    artifacts,
    decide: (request) => decide(harness, request),
  });
  return harness;
}

async function waitForTextFile(
  pathname: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(pathname).exists())
      return await Bun.file(pathname).text();
    await Bun.sleep(10);
  }
  throw new Error(`fixture did not write ${pathname}`);
}

async function waitForRequest(
  harness: GatewayTestHarness,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (harness.requests.length > 0) return;
    await Bun.sleep(10);
  }
  throw new Error("gateway did not receive the execute request");
}

test.skipIf(!artifacts.gatewayPath)(
  "hostexec bare harness requires the standalone client only when run",
  async () => {
    const harness = await startGatewayTestHarness({
      artifacts: { ...artifacts, clientPath: null },
    });
    try {
      let thrown: unknown;
      try {
        await harness.runBareShell("true");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        "standalone client artifact is unavailable",
      );
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: forwards the command through the gateway and relays output",
  async () => {
    const harness = await startClientHarness(async (h, request) => {
      const binary = await writeRealBinary(
        h,
        "git",
        '#!/bin/sh\nprintf "hello from broker"\nprintf "some error output" >&2\nexit 3\n',
      );
      return startRealBinary(h, request, binary);
    });
    try {
      await linkClient(harness, "git");
      const result = await harness.runShell("git status --short");

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("hello from broker");
      expect(result.stderr).toContain("some error output");

      expect(harness.requests.length).toBe(1);
      const request = harness.requests[0];
      expect(path.basename(request.argv0)).toBe("git");
      expect(request.args).toEqual(["status", "--short"]);
      expect(request.sessionId).toBe("test-session");
      // Bun's stdin=ignore is a read-only non-TTY descriptor, so it is
      // intentionally eligible for the v2 fd transport.
      expect(request.stdinMode).toBe("fd");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: forwards stdin through the gateway without reading it",
  async () => {
    const harness = await startClientHarness(async (h, request) => {
      const binary = await writeRealBinary(h, "git", "#!/bin/sh\nexec cat\n");
      return startRealBinary(h, request, binary);
    });
    try {
      await linkClient(harness, "git");
      const result = await harness.runShell(
        "printf 'piped input' | git hash-object --stdin",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("piped input");
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: falls back to the real binary further along PATH",
  async () => {
    const harness = await startClientHarness(() => ({ type: "fallback" }));
    try {
      await linkClient(harness, "git");
      await writeRealBinary(
        harness,
        "git",
        '#!/bin/sh\necho "real git: $*"\nexit 7\n',
      );

      const result = await harness.runShell("git log --oneline");

      expect(result.stdout.trim()).toBe("real git: log --oneline");
      expect(result.exitCode).toBe(7);
      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: a denied command fails instead of running locally",
  async () => {
    const harness = await startClientHarness(() => ({
      type: "error",
      message: "permission denied by hostexec policy",
    }));
    try {
      await linkClient(harness, "git");
      await writeRealBinary(harness, "git", "#!/bin/sh\necho SHOULD-NOT-RUN\n");

      const result = await harness.runShell("git push --force");

      expect(result.stdout).not.toContain("SHOULD-NOT-RUN");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("permission denied by hostexec policy");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: explicit fallback preserves unread stdin",
  async () => {
    const harness = await startClientHarness(() => ({ type: "fallback" }));
    try {
      await linkClient(harness, "git");
      await writeRealBinary(harness, "git", "#!/bin/sh\nexec cat\n");

      const result = await harness.runShell(
        "printf 'piped input' | { git hash-object --stdin; cat; }",
      );

      expect(result.stdout).toBe("piped input");
      expect(result.exitCode).toBe(0);
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: approval wait leaves the first stdin byte available until host start",
  async () => {
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const harness = await startClientHarness(
      async (harnessForDecision, request) => {
        await approval;
        const binary = await writeRealBinary(
          harnessForDecision,
          "git",
          "#!/bin/sh\nexec cat\n",
        );
        return startRealBinary(harnessForDecision, request, binary);
      },
    );
    const helperPath = path.join(harness.rootDir, "observe-before-approval.py");
    const peekPath = path.join(harness.rootDir, "peeked-byte");
    const releasePath = path.join(harness.rootDir, "release-approval");
    let run: Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }> | null = null;
    try {
      await linkClient(harness, "git");
      await writeFile(
        helperPath,
        `#!/usr/bin/env python3
import ctypes
import os
import time

client = ${JSON.stringify(artifacts.clientPath!)}
peek_path = ${JSON.stringify(peekPath)}
release_path = ${JSON.stringify(releasePath)}
read_fd, write_fd = os.pipe()
peek_read, peek_write = os.pipe()
child = os.fork()
if child == 0:
    os.close(write_fd)
    os.close(peek_read)
    os.close(peek_write)
    os.dup2(read_fd, 0)
    os.execv(client, ["git"])
    os._exit(127)

observer_fd = os.dup(read_fd)
os.close(read_fd)
os.write(write_fd, b"a")
tee = ctypes.CDLL(None, use_errno=True).tee
tee.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_size_t, ctypes.c_uint]
tee.restype = ctypes.c_ssize_t
if tee(observer_fd, peek_write, 1, 2) != 1:
    raise OSError(ctypes.get_errno(), "tee failed")
first = os.read(peek_read, 1)
with open(peek_path, "wb") as marker:
    marker.write(first)
while not os.path.exists(release_path):
    time.sleep(0.01)
os.write(write_fd, b"b")
os.close(write_fd)
_, status = os.waitpid(child, 0)
os._exit(os.waitstatus_to_exitcode(status))
`,
      );
      await chmod(helperPath, 0o700);

      run = harness.runShell(`exec '${helperPath}'`);
      expect(await waitForTextFile(peekPath)).toBe("a");
      await writeFile(releasePath, "approved");
      releaseApproval();
      const result = await run;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ab");
      expect(result.stderr).toBe("");
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
    } finally {
      if (run) {
        await writeFile(releasePath, "cleanup").catch(() => {});
        releaseApproval();
        await run.catch(() => {});
      }
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: rejects O_RDWR socketpair stdin before sending or falling back",
  async () => {
    const harness = await startGatewayTestHarness({
      artifacts,
      decide: () => {
        throw new Error("O_RDWR stdin must not reach the broker");
      },
    });
    const helperPath = path.join(harness.rootDir, "exec-client-rw.py");
    try {
      await linkClient(harness, "git");
      await writeRealBinary(
        harness,
        "git",
        "#!/bin/sh\nprintf LOCAL-FALLBACK-RAN >&2\nexit 99\n",
      );
      await writeFile(
        helperPath,
        `#!/usr/bin/env python3
import os
import socket

left, right = socket.socketpair()
try:
    os.dup2(left.fileno(), 0)
    os.execv(${JSON.stringify(artifacts.clientPath!)}, ["git"])
finally:
    right.close()
    left.close()
`,
      );
      await chmod(helperPath, 0o700);

      const result = await harness.runShell(`exec '${helperPath}'`);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        "refusing read-write stdin because it can bypass output masking",
      );
      expect(result.stderr).not.toContain("LOCAL-FALLBACK-RAN");
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: an unreachable broker fails closed instead of running locally",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      await linkClient(harness, "cat");
      await writeRealBinary(
        harness,
        "cat",
        `#!/bin/sh\nprintf LOCAL-FALLBACK-RAN >&2\nexec ${realCat} "$@"\n`,
      );

      const result = await harness.runShell(
        `printf 'piped input' | { cat; ${realCat}; exit 1; }`,
        {
          socketPath: path.join(harness.rootDir, "does-not-exist.sock"),
        },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("piped input");
      expect(result.stderr).toContain("cannot reach the broker");
      expect(result.stderr).not.toContain("LOCAL-FALLBACK-RAN");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: an internal broker disconnect before start fails closed without consuming stdin",
  async () => {
    let releaseStart!: () => void;
    const start = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await startClientHarness(async (h, request) => {
      await start;
      return {
        type: "start",
        spec: {
          argv0: realCat,
          args: request.args,
          cwd: h.rootDir,
          env: { PATH: process.env.PATH ?? "" },
        },
      };
    });
    let run: Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }> | null = null;
    try {
      await linkClient(harness, "cat");
      await writeRealBinary(
        harness,
        "cat",
        "#!/bin/sh\nprintf LOCAL-FALLBACK-RAN >&2\nexit 77\n",
      );
      run = harness.runShell(
        `printf 'piped input' | { cat; ${realCat}; exit 1; }`,
      );
      await waitForRequest(harness);
      expect(harness.events).toHaveLength(0);
      await harness.disconnectBroker();
      releaseStart();

      const result = await run;
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("piped input");
      expect(result.stderr).toContain("hostexec broker disconnected");
      expect(result.stderr).not.toContain("LOCAL-FALLBACK-RAN");
      expect(harness.events).toHaveLength(0);
    } finally {
      releaseStart();
      if (run) await run.catch(() => {});
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: missing broker environment fails closed",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      await linkClient(harness, "cat");
      await writeRealBinary(
        harness,
        "cat",
        `#!/bin/sh\nexec ${realCat} "$@"\n`,
      );

      const result = await harness.runShell("printf 'piped input' | cat", {
        socketPath: null,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("broker environment is incomplete");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: missing session id fails closed",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      await linkClient(harness, "cat");
      await writeRealBinary(
        harness,
        "cat",
        `#!/bin/sh\nexec ${realCat} "$@"\n`,
      );

      const result = await harness.runShell("printf 'piped input' | cat", {
        sessionId: null,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("broker environment is incomplete");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!clientGatewayAvailable)(
  "hostexec client: reports a missing fallback binary instead of looping",
  async () => {
    const harness = await startClientHarness(() => ({ type: "fallback" }));
    try {
      await linkClient(harness, "git");
      const result = await harness.runShell("git status", {
        pathEnv: `${harness.wrapperDir}:${harness.realDir}`,
      });

      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("fallback binary not found");
      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  },
);

// バイナリが無いときだけ走る診断。欠けている成果物を明示した skip として
// 数えるため、成果物が無い環境でも suite が無言で成功しない。
test.skipIf(clientGatewayAvailable)(
  "hostexec client tests skipped (artifacts unavailable: cd src/hostexec/intercept && zig build)",
  () => {
    expect(clientGatewayAvailable).toBe(false);
  },
);
