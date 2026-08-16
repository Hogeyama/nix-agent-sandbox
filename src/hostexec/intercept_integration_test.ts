import { expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExternalExecuteRequestV2 } from "./gateway_protocol.ts";
import {
  type GatewayDecision,
  type GatewayTestHarness,
  resolveGatewayTestArtifacts,
  startGatewayTestHarness,
} from "./gateway_test_harness.ts";

/**
 * LD_PRELOAD integration tests deliberately put the real gateway between the
 * interceptor and the mock internal broker.  The gateway is the component
 * that receives SCM_RIGHTS, so a direct Node Unix server would not exercise
 * the v2 transport at all.
 */
const artifacts = await resolveGatewayTestArtifacts();
const interceptGatewayAvailable = Boolean(
  artifacts.interceptLibPath && artifacts.gatewayPath,
);
const echoPath = Bun.which("echo");

async function writeHostBinary(
  harness: GatewayTestHarness,
  name: string,
  script: string,
): Promise<string> {
  const target = path.join(harness.rootDir, name);
  await writeFile(target, script);
  await chmod(target, 0o755);
  return target;
}

function startHostBinary(
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
      env: { PATH: process.env.PATH ?? "" },
    },
  };
}

async function startInterceptHarness(
  decide: (
    harness: GatewayTestHarness,
    request: ExternalExecuteRequestV2,
  ) => GatewayDecision | Promise<GatewayDecision>,
): Promise<GatewayTestHarness> {
  let harness!: GatewayTestHarness;
  harness = await startGatewayTestHarness({
    artifacts,
    decide: (request) => decide(harness, request),
  });
  return harness;
}

test.skipIf(!interceptGatewayAvailable)(
  "intercept .so: gateway runs without the standalone client artifact",
  async () => {
    const harness = await startGatewayTestHarness({
      artifacts: { ...artifacts, clientPath: null },
    });
    try {
      const result = await harness.runInterceptedShell(
        `exec '${harness.interceptedNoReadPath}'`,
      );

      expect(result.exitCode).toBe(0);
      expect(harness.requests).toHaveLength(1);
      expect(harness.events.map(({ type }) => type)).toEqual([
        "spawned",
        "process_exit",
        "result",
      ]);
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!interceptGatewayAvailable)(
  "intercept .so: gateway returns exitCode=0 with stdout and stderr",
  async () => {
    const harness = await startInterceptHarness(async (h, request) => {
      const binary = await writeHostBinary(
        h,
        "host-output",
        '#!/bin/sh\nprintf "hello from broker"\nprintf "some error output" >&2\nexit 0\n',
      );
      return startHostBinary(h, request, binary);
    });
    try {
      const result = await harness.runInterceptedShell(
        `exec '${harness.interceptedNoReadPath}'`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello from broker");
      expect(result.stderr).toContain("some error output");
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!interceptGatewayAvailable)(
  "intercept .so: gateway returns non-zero exit code",
  async () => {
    const harness = await startInterceptHarness(async (h, request) => {
      const binary = await writeHostBinary(
        h,
        "host-exit",
        "#!/bin/sh\nexit 42\n",
      );
      return startHostBinary(h, request, binary);
    });
    try {
      const result = await harness.runInterceptedShell(
        `exec '${harness.interceptedNoReadPath}'`,
      );

      expect(result.exitCode).toBe(42);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!interceptGatewayAvailable)(
  "intercept .so: a denied command fails instead of running the real binary",
  async () => {
    const harness = await startInterceptHarness(() => ({
      type: "error",
      message: "permission denied by hostexec policy",
    }));
    try {
      await writeFile(harness.interceptedNoReadPath, "#!/bin/sh\nexit 99\n");
      await chmod(harness.interceptedNoReadPath, 0o755);
      const result = await harness.runInterceptedShell(
        `exec '${harness.interceptedNoReadPath}'`,
      );

      expect(result.exitCode).toBe(1);
      expect(result.exitCode).not.toBe(99);
      expect(result.stderr).toContain("permission denied by hostexec policy");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!interceptGatewayAvailable || !echoPath)(
  "intercept .so: non-intercepted command runs normally",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      const result = await harness.runShell(`${echoPath} normal-output`, {
        interceptedPath: path.join(harness.rootDir, "not-the-command-we-run"),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("normal-output");
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  },
);

// ライブラリまたは gateway が無いときだけ走る診断。各ケースを無言で通さず、
// 欠けている native 成果物を build コマンド付きで報告する。
test.skipIf(interceptGatewayAvailable)(
  "hostexec intercept tests skipped (artifacts unavailable: cd src/hostexec/intercept && zig build)",
  () => {
    expect(interceptGatewayAvailable).toBe(false);
  },
);
