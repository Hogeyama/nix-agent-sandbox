import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type GatewayDecision,
  resolveGatewayTestArtifacts,
  startGatewayTestHarness,
} from "./gateway_test_harness.ts";

const artifacts = await resolveGatewayTestArtifacts();
const bashAvailable = Bun.which("bash") !== null;
const catAvailable = Bun.which("cat") !== null;
const headAvailable = Bun.which("head") !== null;
const ddAvailable = Bun.which("dd") !== null;
const setsidAvailable = Bun.which("setsid") !== null;
const prerequisiteAvailability = {
  bash: bashAvailable,
  cat: catAvailable,
  head: headAvailable,
  dd: ddAvailable,
  setsid: setsidAvailable,
  client: artifacts.clientPath !== null,
  gateway: artifacts.gatewayPath !== null,
  interceptor: artifacts.interceptLibPath !== null,
} as const;
const missingPrerequisites = Object.entries(prerequisiteAvailability)
  .filter(([, available]) => !available)
  .map(([name]) => name);
const missingPrerequisiteReason =
  missingPrerequisites.length === 0
    ? "all prerequisites present; no diagnostic needed"
    : `missing ${missingPrerequisites.join(", ")}; install bash/coreutils and util-linux (for setsid) as needed and run ` +
      "cd src/hostexec/intercept && zig build";
const bareGatewayAvailable =
  prerequisiteAvailability.bash &&
  prerequisiteAvailability.cat &&
  prerequisiteAvailability.head &&
  prerequisiteAvailability.dd &&
  prerequisiteAvailability.client &&
  prerequisiteAvailability.gateway;
const interceptedGatewayAvailable =
  prerequisiteAvailability.bash &&
  prerequisiteAvailability.cat &&
  prerequisiteAvailability.head &&
  prerequisiteAvailability.dd &&
  prerequisiteAvailability.gateway &&
  prerequisiteAvailability.interceptor;
const bareBackpressureAvailable = bareGatewayAvailable && setsidAvailable;

type GatewayHarness = Awaited<ReturnType<typeof startGatewayTestHarness>>;

async function findProcessByExecutable(
  executable: string,
  cwd?: string,
  commandLineNeedle?: string,
): Promise<number | null> {
  const expectedExecutable = await realpath(executable).catch(() => executable);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      if ((await readlink(`/proc/${entry.name}/exe`)) !== expectedExecutable)
        continue;
      if (cwd && (await readlink(`/proc/${entry.name}/cwd`)) !== cwd) continue;
      if (
        commandLineNeedle &&
        !(await readFile(`/proc/${entry.name}/cmdline`)).includes(
          commandLineNeedle,
        )
      )
        continue;
      return Number(entry.name);
    } catch {
      // Processes can exit between readdir and readlink.
    }
  }
  return null;
}

async function readRssKiB(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function waitForRssKiB(pid: number, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rss = await readRssKiB(pid);
    if (rss !== null) return rss;
    await Bun.sleep(10);
  }
  throw new Error(`RSS baseline did not become readable for PID ${pid}`);
}

interface ProcessSnapshot {
  readonly pid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTime: number;
  readonly state: string;
}

async function readProcessSnapshot(
  pid: number,
): Promise<ProcessSnapshot | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(") ");
    if (close <= 0) return null;
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const values = [Number(fields[2]), Number(fields[3]), Number(fields[19])];
    if (values.some((value) => !Number.isSafeInteger(value))) return null;
    return {
      pid,
      state: fields[0],
      processGroupId: values[0],
      sessionId: values[1],
      startTime: values[2],
    };
  } catch {
    return null;
  }
}

async function waitForGatewayHandler(
  gatewayPid: number,
  timeoutMs = 2_000,
): Promise<number> {
  const gatewayExecutable = await realpath(artifacts.gatewayPath!).catch(
    () => artifacts.gatewayPath!,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const children = await readFile(
        `/proc/${gatewayPid}/task/${gatewayPid}/children`,
        "utf8",
      );
      for (const child of children.trim().split(/\s+/)) {
        if (!child) continue;
        const executable = await readlink(`/proc/${child}/exe`).catch(() => "");
        if (executable === gatewayExecutable) return Number(child);
      }
    } catch {
      // The gateway can reap a handler between the proc reads.
    }
    await Bun.sleep(10);
  }
  throw new Error(`gateway handler did not start under ${gatewayPid}`);
}

async function waitForProcessSnapshot(
  pid: number,
  timeoutMs = 2_000,
): Promise<ProcessSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readProcessSnapshot(pid);
    if (
      snapshot &&
      snapshot.startTime > 0 &&
      snapshot.processGroupId === pid &&
      snapshot.sessionId === pid
    ) {
      return snapshot;
    }
    await Bun.sleep(10);
  }
  throw new Error(`process identity did not start: ${pid}`);
}

async function readProcessGroupMembers(
  processGroupId: number,
  sessionId: number,
): Promise<ProcessSnapshot[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const members: ProcessSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const snapshot = await readProcessSnapshot(Number(entry.name));
    if (
      snapshot &&
      snapshot.processGroupId === processGroupId &&
      snapshot.sessionId === sessionId
    ) {
      members.push(snapshot);
    }
  }
  return members;
}

async function waitForProcessGroupGone(
  identity: ProcessSnapshot,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const members = await readProcessGroupMembers(
      identity.processGroupId,
      identity.sessionId,
    );
    if (members.length === 0) return;
    await Bun.sleep(10);
  }
  throw new Error(
    `process group ${identity.processGroupId} did not exit cleanly`,
  );
}

async function signalOwnedProcessGroup(
  identity: ProcessSnapshot,
  signal: "SIGTERM" | "SIGKILL",
): Promise<boolean> {
  const leader = await readProcessSnapshot(identity.pid);
  if (
    leader &&
    (leader.startTime !== identity.startTime ||
      leader.processGroupId !== identity.processGroupId ||
      leader.sessionId !== identity.sessionId)
  ) {
    throw new Error(`process identity changed before ${signal}`);
  }
  if (!leader) {
    const members = await readProcessGroupMembers(
      identity.processGroupId,
      identity.sessionId,
    );
    if (members.length === 0) return false;
  }
  if (identity.processGroupId <= 1) {
    throw new Error("refusing to signal an unsafe process group");
  }
  try {
    process.kill(-identity.processGroupId, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && /ESRCH/.test(error.message)) return false;
    throw error;
  }
}

async function terminateHarnessShell(
  child: ReturnType<typeof Bun.spawn>,
  releasePath: string,
  identity: ProcessSnapshot,
): Promise<void> {
  // Release the producer gate first so an interrupted assertion cannot leave
  // a dd process blocked in the pipeline while the shell is being reaped.
  await writeFile(releasePath, "cleanup").catch(() => {});
  await signalOwnedProcessGroup(identity, "SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (!exited) await signalOwnedProcessGroup(identity, "SIGKILL");
  await child.exited;
  try {
    await waitForProcessGroupGone(identity, 500);
  } catch {
    await signalOwnedProcessGroup(identity, "SIGKILL");
    await waitForProcessGroupGone(identity);
  }
}

async function waitForExecutable(
  executable: string,
  timeoutMs = 2_000,
  cwd?: string,
  commandLineNeedle?: string,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await findProcessByExecutable(
      executable,
      cwd,
      commandLineNeedle,
    );
    if (pid !== null) return pid;
    await Bun.sleep(10);
  }
  throw new Error(`process did not start: ${executable}`);
}

function spawnHarnessShell(
  harness: GatewayHarness,
  script: string,
): ReturnType<typeof Bun.spawn> {
  const bashPath = Bun.which("bash");
  if (!bashPath) throw new Error("bash is required for gateway tests");
  const setsidPath = Bun.which("setsid");
  if (!setsidPath) throw new Error("setsid is required for gateway tests");
  const childEnv = { ...process.env };
  delete childEnv.LD_PRELOAD;
  delete childEnv.NAS_HOSTEXEC_INTERCEPT_PATHS;
  delete childEnv.NAS_HOSTEXEC_SESSION_ID;
  delete childEnv.NAS_HOSTEXEC_SOCKET;
  delete childEnv.NAS_HOSTEXEC_WRAPPER_DIR;
  return Bun.spawn([setsidPath, bashPath, "-c", script], {
    cwd: harness.rootDir,
    env: {
      ...childEnv,
      PATH: `${harness.wrapperDir}:${harness.realDir}:${process.env.PATH ?? ""}`,
      NAS_HOSTEXEC_WRAPPER_DIR: harness.wrapperDir,
      NAS_HOSTEXEC_SOCKET: harness.externalSocketPath,
      NAS_HOSTEXEC_SESSION_ID: "test-session",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runBackpressureCase(
  harness: GatewayHarness,
  command: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const releasePath = path.join(harness.rootDir, "release-payload");
  const release = JSON.stringify(releasePath);
  const child = spawnHarnessShell(
    harness,
    `{ while [ ! -e ${release} ]; do sleep 0.01; done; dd if=/dev/zero bs=65536 count=256 status=none; } | ${command}`,
  );
  let shellIdentity: ProcessSnapshot | null = null;
  let finished = false;
  const stdout = new Response(
    child.stdout as ReadableStream<Uint8Array>,
  ).text();
  const stderr = new Response(
    child.stderr as ReadableStream<Uint8Array>,
  ).text();
  const exited = child.exited.then(() => {
    finished = true;
  });
  let disarmed = false;
  try {
    shellIdentity = await waitForProcessSnapshot(child.pid);
    expect(shellIdentity.processGroupId).toBe(child.pid);
    expect(shellIdentity.sessionId).toBe(child.pid);
    const gatewayPid = await waitForExecutable(
      artifacts.gatewayPath!,
      2_000,
      undefined,
      harness.externalSocketPath,
    );
    const handlerPid = await waitForGatewayHandler(gatewayPid);
    const clientPidBefore = await waitForExecutable(
      artifacts.clientPath!,
      2_000,
      harness.rootDir,
    );
    expect(clientPidBefore).not.toBe(child.pid);
    expect(clientPidBefore).not.toBe(gatewayPid);
    // Keep the producer gate closed until both exact processes have a real
    // /proc RSS baseline. A missing baseline must fail this test while the
    // fixture remains gated and therefore still belongs to the cleanup guard;
    // treating it as zero would make the memory-growth proof conditional.
    const handlerBaseline = await waitForRssKiB(handlerPid);
    const clientBaseline = await waitForRssKiB(clientPidBefore);
    let handlerPeak = handlerBaseline;
    let clientPeak = clientBaseline;
    await writeFile(releasePath, "release");
    while (!finished) {
      const handlerRss = await readRssKiB(handlerPid);
      if (handlerRss !== null) handlerPeak = Math.max(handlerPeak, handlerRss);
      const clientPid = await findProcessByExecutable(
        artifacts.clientPath!,
        harness.rootDir,
      );
      if (clientPid !== null) {
        const clientRss = await readRssKiB(clientPid);
        if (clientRss !== null) clientPeak = Math.max(clientPeak, clientRss);
      }
      await Bun.sleep(20);
    }
    await exited;
    await waitForProcessGroupGone(shellIdentity);
    // The process has been fully awaited; later assertion failures cannot
    // leave the bash/dd pipeline behind, so its cleanup guard may disarm.
    disarmed = true;
    const [out, err] = await Promise.all([stdout, stderr]);
    const expectedHash = createHash("sha256")
      .update(Buffer.alloc(16 * 1024 * 1024))
      .digest("hex");
    expect(out.trim()).toBe(`16777216:${expectedHash}`);
    expect(err).toBe("");

    // The fixed 12 MiB ceiling is deliberately generous for Zig/Bun allocator
    // noise, but remains below the 16 MiB payload. A full user-space snapshot
    // would therefore fail this regression while bounded kernel backpressure
    // remains comfortably below it.
    const maxGrowthKiB = 12 * 1024;
    expect(handlerPeak - handlerBaseline).toBeLessThan(maxGrowthKiB);
    expect(handlerPeak - handlerBaseline).toBeLessThan(16 * 1024);
    expect(clientPeak - clientBaseline).toBeLessThan(maxGrowthKiB);
    expect(clientPeak - clientBaseline).toBeLessThan(16 * 1024);
    return { stdout: out, stderr: err };
  } finally {
    if (!disarmed) {
      if (shellIdentity) {
        await terminateHarnessShell(child, releasePath, shellIdentity);
      } else {
        await writeFile(releasePath, "cleanup").catch(() => {});
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }
}

test.skipIf(!bareGatewayAvailable)(
  "bare hostexec preserves bytes left for a trailing reader after a partial host read",
  async () => {
    const hostHead = Bun.which("head");
    if (!hostHead) throw new Error("head is required for this regression");
    let harness: Awaited<ReturnType<typeof startGatewayTestHarness>> | null =
      null;
    try {
      harness = await startGatewayTestHarness({
        artifacts,
        decide: (request): GatewayDecision => ({
          type: "start",
          spec: {
            argv0: hostHead,
            args: request.args,
            cwd: harness!.rootDir,
            env: { PATH: process.env.PATH ?? "" },
          },
        }),
      });
      await symlink(
        artifacts.clientPath!,
        path.join(harness.wrapperDir, "git"),
      );

      const result = await harness.runShell(
        "printf payload | { git -c 3; cat; }",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("payload");
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
    } finally {
      await harness?.close();
    }
  },
);

test.skipIf(!bareGatewayAvailable)(
  "bare hostexec follows a slow producer without dropping delayed stdin",
  async () => {
    const hostCat = Bun.which("cat");
    if (!hostCat) throw new Error("cat is required for this regression");
    let harness: Awaited<ReturnType<typeof startGatewayTestHarness>> | null =
      null;
    try {
      harness = await startGatewayTestHarness({
        artifacts,
        decide: (request): GatewayDecision => ({
          type: "start",
          spec: {
            argv0: hostCat,
            args: request.args,
            cwd: harness!.rootDir,
            env: { PATH: process.env.PATH ?? "" },
          },
        }),
      });
      await symlink(
        artifacts.clientPath!,
        path.join(harness.wrapperDir, "git"),
      );

      const result = await harness.runShell(
        "{ printf a; sleep 0.4; printf b; } | git",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ab");
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
    } finally {
      await harness?.close();
    }
  },
);

test.skipIf(!interceptedGatewayAvailable)(
  "LD_PRELOAD hostexec preserves bytes left for a trailing reader after a partial host read",
  async () => {
    const hostHead = Bun.which("head");
    if (!hostHead) throw new Error("head is required for this regression");
    let harness: Awaited<ReturnType<typeof startGatewayTestHarness>> | null =
      null;
    try {
      harness = await startGatewayTestHarness({
        artifacts,
        decide: (request): GatewayDecision => ({
          type: "start",
          spec: {
            argv0: hostHead,
            args: request.args,
            cwd: harness!.rootDir,
            env: { PATH: process.env.PATH ?? "" },
          },
        }),
      });

      const result = await harness.runInterceptedShell(
        `printf payload | { '${harness.interceptedNoReadPath}' -c 3; cat; }`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("payload");
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
    } finally {
      await harness?.close();
    }
  },
);

test.skipIf(!bareBackpressureAvailable)(
  "bare hostexec applies bounded backpressure to a slow 16 MiB host consumer",
  async () => {
    let harness: GatewayHarness | null = null;
    let slowConsumerPath = "";
    try {
      harness = await startGatewayTestHarness({
        artifacts,
        decide: (request): GatewayDecision => ({
          type: "start",
          spec: {
            argv0: process.execPath,
            args: [slowConsumerPath, ...request.args],
            cwd: harness!.rootDir,
            env: { PATH: process.env.PATH ?? "" },
          },
        }),
      });
      slowConsumerPath = path.join(harness.rootDir, "slow-consumer.ts");
      await writeFile(
        slowConsumerPath,
        `import { createHash } from "node:crypto";
const hash = createHash("sha256");
let count = 0;
for await (const chunk of Bun.stdin.stream()) {
  hash.update(chunk);
  count += chunk.length;
  await Bun.sleep(5);
}
process.stdout.write(String(count) + ":" + hash.digest("hex") + "\\n");
`,
      );
      await chmod(slowConsumerPath, 0o700);
      await symlink(
        artifacts.clientPath!,
        path.join(harness.wrapperDir, "git"),
      );

      await runBackpressureCase(harness, "git");
    } finally {
      await harness?.close();
    }
  },
);

test.skipIf(!bareGatewayAvailable)(
  "bare hostexec leaves unread stdin for the next command",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      const result = await harness.runBareShell(
        "printf payload | { intercepted-no-read; cat; }",
      );
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
      expect(harness.events.map(({ type }) => type)).toEqual([
        "spawned",
        "process_exit",
        "result",
      ]);
      expect(harness.events[1]).toMatchObject({
        type: "process_exit",
        exitCode: 0,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("payload");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!interceptedGatewayAvailable)(
  "LD_PRELOAD hostexec leaves unread stdin for the next command",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      const result = await harness.runInterceptedShell(
        `printf payload | { '${harness.interceptedNoReadPath}'; cat; }`,
      );
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
      expect(harness.events.map(({ type }) => type)).toEqual([
        "spawned",
        "process_exit",
        "result",
      ]);
      expect(harness.events[1]).toMatchObject({
        type: "process_exit",
        exitCode: 0,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("payload");
    } finally {
      await harness.close();
    }
  },
);

if (artifacts.gatewayPath !== null) {
  test("hostexec gateway artifact is available", () => {
    expect(artifacts.gatewayPath).not.toBeNull();
  });
} else {
  test.skip("hostexec gateway tests skipped (gateway binary not built: cd src/hostexec/intercept && zig build)", () => {});
}

if (missingPrerequisites.length === 0) {
  test("hostexec FD gateway prerequisites are available", () => {
    expect(missingPrerequisites).toEqual([]);
  });
} else {
  test.skip(`hostexec FD gateway regressions skipped (${missingPrerequisiteReason})`, () => {});
}
