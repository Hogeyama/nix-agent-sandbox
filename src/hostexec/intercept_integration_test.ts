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

function spawnInterceptedShell(
  harness: GatewayTestHarness,
  script: string,
): ReturnType<typeof Bun.spawn> {
  const bashPath = Bun.which("bash");
  if (!bashPath) throw new Error("bash is required for intercept tests");
  const childEnv = { ...process.env };
  delete childEnv.LD_PRELOAD;
  delete childEnv.NAS_HOSTEXEC_INTERCEPT_PATHS;
  delete childEnv.NAS_HOSTEXEC_SESSION_ID;
  delete childEnv.NAS_HOSTEXEC_SOCKET;
  delete childEnv.NAS_HOSTEXEC_WRAPPER_DIR;
  return Bun.spawn([bashPath, "-c", script], {
    cwd: harness.rootDir,
    env: {
      ...childEnv,
      PATH: `${harness.wrapperDir}:${harness.realDir}:${process.env.PATH ?? ""}`,
      NAS_HOSTEXEC_WRAPPER_DIR: harness.wrapperDir,
      NAS_HOSTEXEC_SOCKET: harness.externalSocketPath,
      NAS_HOSTEXEC_SESSION_ID: "test-session",
      LD_PRELOAD: harness.artifacts.interceptLibPath!,
      NAS_HOSTEXEC_INTERCEPT_PATHS: harness.interceptedNoReadPath,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForText(
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

interface ProcessIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startTime: number;
  readonly state: string;
}

async function readProcessIdentity(
  pid: number,
): Promise<ProcessIdentity | null> {
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text();
    const commEnd = stat.lastIndexOf(") ");
    if (commEnd <= 0) return null;
    const fields = stat
      .slice(commEnd + 2)
      .trim()
      .split(/\s+/);
    const processGroupId = Number(fields[2]);
    const startTime = Number(fields[19]);
    if (
      !Number.isSafeInteger(processGroupId) ||
      !Number.isSafeInteger(startTime)
    ) {
      return null;
    }
    return { pid, processGroupId, startTime, state: fields[0] };
  } catch {
    return null;
  }
}

async function waitForOwnedProcessGone(
  identity: ProcessIdentity,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readProcessIdentity(identity.pid);
    if (!current || current.state === "Z") return;
    if (
      current.startTime !== identity.startTime ||
      current.processGroupId !== identity.processGroupId
    ) {
      throw new Error(
        `process ${identity.pid} identity changed during cleanup`,
      );
    }
    await Bun.sleep(10);
  }
  const current = await readProcessIdentity(identity.pid);
  if (
    current &&
    (current.startTime !== identity.startTime ||
      current.processGroupId !== identity.processGroupId)
  ) {
    throw new Error(`process ${identity.pid} identity changed during cleanup`);
  }
  throw new Error(`process ${identity.pid} survived client disconnect`);
}

async function signalOwnedProcessGroup(
  identities: readonly ProcessIdentity[],
  signal: "SIGKILL",
): Promise<void> {
  for (const identity of identities) {
    const current = await readProcessIdentity(identity.pid);
    if (!current || current.state === "Z") continue;
    if (
      current.startTime !== identity.startTime ||
      current.processGroupId !== identity.processGroupId
    ) {
      throw new Error(
        `refusing to signal reused process group ${identity.processGroupId}`,
      );
    }
    if (current.processGroupId <= 1) {
      throw new Error("refusing to signal an unsafe process group");
    }
    try {
      process.kill(-current.processGroupId, signal);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/ESRCH|not found/i.test(error.message)
      ) {
        throw error;
      }
    }
    return;
  }
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

test.skipIf(!interceptGatewayAvailable)(
  "intercept .so: an unreachable gateway fails closed without local execution",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      await writeFile(
        harness.interceptedNoReadPath,
        "#!/bin/sh\nprintf LOCAL-RAN\n",
      );
      await chmod(harness.interceptedNoReadPath, 0o755);
      const result = await harness.runShell(
        `exec '${harness.interceptedNoReadPath}'`,
        {
          interceptedPath: harness.interceptedNoReadPath,
          socketPath: path.join(harness.rootDir, "missing-gateway.sock"),
        },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("cannot reach the broker");
      expect(result.stdout).not.toContain("LOCAL-RAN");
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!interceptGatewayAvailable)(
  "intercept .so: external disconnect kills a SIGTERM-ignoring host descendant",
  async () => {
    let harness!: GatewayTestHarness;
    let hostScript = "";
    let leaderIdentity: ProcessIdentity | null = null;
    let descendantIdentity: ProcessIdentity | null = null;
    harness = await startInterceptHarness(async (h, request) => {
      hostScript = path.join(h.rootDir, "term-ignoring-host.ts");
      const descendantScript = path.join(
        h.rootDir,
        "term-ignoring-descendant.ts",
      );
      const leaderInfo = path.join(h.rootDir, "host-info.json");
      const descendantInfo = path.join(h.rootDir, "descendant-info.json");
      const descendantReady = path.join(h.rootDir, "descendant-ready.json");
      await writeFile(
        descendantScript,
        `async function processIdentity(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const stat = await Bun.file("/proc/" + pid + "/stat").text();
      const commEnd = stat.lastIndexOf(")");
      const fields = stat.slice(commEnd + 2).trim().split(/\\s+/);
      return { pid, pgid: Number(fields[2]), startTime: Number(fields[19]) };
    } catch {}
    await Bun.sleep(5);
  }
  throw new Error("descendant process identity did not appear");
}
process.on("SIGTERM", () => {});
await Bun.write(${JSON.stringify(descendantReady)}, JSON.stringify(await processIdentity(process.pid)));
await new Promise(() => {});
`,
      );
      await chmod(descendantScript, 0o700);
      await writeFile(
        hostScript,
        `async function processIdentity(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const stat = await Bun.file("/proc/" + pid + "/stat").text();
      const commEnd = stat.lastIndexOf(")");
      const fields = stat.slice(commEnd + 2).trim().split(/\\s+/);
      return { pid, pgid: Number(fields[2]), startTime: Number(fields[19]) };
    } catch {}
    await Bun.sleep(5);
  }
  throw new Error("leader process identity did not appear");
}
async function waitForReady(pathname) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Bun.file(pathname).exists()) return JSON.parse(await Bun.file(pathname).text());
    await Bun.sleep(5);
  }
  throw new Error("descendant readiness marker did not appear");
}
process.on("SIGTERM", () => {
  process.exit(0);
});
const descendant = Bun.spawn([${JSON.stringify(process.execPath)}, ${JSON.stringify(descendantScript)}], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
const descendantReadyRecord = await waitForReady(${JSON.stringify(descendantReady)});
const leaderRecord = await processIdentity(process.pid);
await Bun.write(${JSON.stringify(leaderInfo)}, JSON.stringify(leaderRecord));
await Bun.write(${JSON.stringify(descendantInfo)}, JSON.stringify(descendantReadyRecord));
await new Promise(() => {});
`,
      );
      await chmod(hostScript, 0o700);
      return {
        type: "start",
        spec: {
          argv0: process.execPath,
          args: [hostScript, ...request.args],
          cwd: h.rootDir,
          env: { PATH: process.env.PATH ?? "" },
        },
      };
    });
    let child: ReturnType<typeof Bun.spawn> | null = null;
    let cleanupArmed = true;
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      child = spawnInterceptedShell(
        harness,
        `exec '${harness.interceptedNoReadPath}'`,
      );
      const descendantReadyRecord = JSON.parse(
        await waitForText(path.join(harness.rootDir, "descendant-ready.json")),
      ) as { pid: number; pgid: number; startTime: number };
      const leaderRecord = JSON.parse(
        await waitForText(path.join(harness.rootDir, "host-info.json")),
      ) as { pid: number; pgid: number; startTime: number };
      const descendantRecord = JSON.parse(
        await waitForText(path.join(harness.rootDir, "descendant-info.json")),
      ) as { pid: number; pgid: number; startTime: number };
      leaderIdentity = await readProcessIdentity(leaderRecord.pid);
      descendantIdentity = await readProcessIdentity(descendantRecord.pid);
      expect(Number.isSafeInteger(leaderRecord.pid)).toBe(true);
      expect(Number.isSafeInteger(descendantRecord.pid)).toBe(true);
      expect(Number.isSafeInteger(leaderRecord.pgid)).toBe(true);
      expect(Number.isSafeInteger(descendantRecord.pgid)).toBe(true);
      expect(leaderRecord.pid).toBeGreaterThan(0);
      expect(descendantRecord.pid).toBeGreaterThan(0);
      expect(leaderRecord.pgid).toBeGreaterThan(0);
      expect(descendantRecord.pgid).toBeGreaterThan(0);
      expect(leaderRecord.pid).not.toBe(descendantRecord.pid);
      expect(leaderRecord.pgid).toBe(descendantRecord.pgid);
      expect(descendantReadyRecord).toEqual(descendantRecord);
      expect(leaderRecord.startTime).toBeGreaterThan(0);
      expect(descendantRecord.startTime).toBeGreaterThan(0);
      expect(leaderIdentity).not.toBeNull();
      expect(descendantIdentity).not.toBeNull();
      if (!leaderIdentity || !descendantIdentity) {
        throw new Error(
          "host process identities disappeared before disconnect",
        );
      }
      expect(leaderIdentity.processGroupId).toBe(leaderRecord.pgid);
      expect(descendantIdentity.processGroupId).toBe(descendantRecord.pgid);
      expect(leaderIdentity.startTime).toBe(leaderRecord.startTime);
      expect(descendantIdentity.startTime).toBe(descendantRecord.startTime);
      child.kill("SIGKILL");
      await child.exited;
      await waitForOwnedProcessGone(leaderIdentity);
      await waitForOwnedProcessGone(descendantIdentity);
      const leaderAfter = await readProcessIdentity(leaderIdentity.pid);
      const descendantAfter = await readProcessIdentity(descendantIdentity.pid);
      expect(!leaderAfter || leaderAfter.state === "Z").toBe(true);
      expect(!descendantAfter || descendantAfter.state === "Z").toBe(true);
      leaderIdentity = null;
      descendantIdentity = null;
      cleanupArmed = false;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      if (cleanupArmed) {
        try {
          const identities = [leaderIdentity, descendantIdentity].filter(
            (identity): identity is ProcessIdentity => identity !== null,
          );
          await signalOwnedProcessGroup(identities, "SIGKILL");
          for (const identity of identities) {
            await waitForOwnedProcessGone(identity);
          }
          cleanupArmed = false;
        } catch (error) {
          cleanupError = error;
        }
      }
      await harness.close();
    }
    if (!primaryError && cleanupError) throw cleanupError;
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

if (interceptGatewayAvailable) {
  test("hostexec intercept artifacts are available", () => {
    expect(interceptGatewayAvailable).toBe(true);
  });
} else {
  test.skip("hostexec intercept tests skipped (artifacts unavailable: cd src/hostexec/intercept && zig build)", () => {});
}
