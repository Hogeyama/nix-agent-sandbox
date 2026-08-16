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
        "printf 'piped input' | git hash-object --stdin",
      );

      expect(result.stdout).toBe("piped input");
      expect(result.exitCode).toBe(0);
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
        `#!/bin/sh\nexec ${realCat} "$@"\n`,
      );

      const result = await harness.runShell("printf 'piped input' | cat", {
        socketPath: path.join(harness.rootDir, "does-not-exist.sock"),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("cannot reach the broker");
    } finally {
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
