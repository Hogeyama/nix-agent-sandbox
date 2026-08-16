import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { queryAuditLogs } from "../audit/store.ts";
import type { HostExecConfig } from "../config/types.ts";
import {
  connectUnix,
  readJsonLine,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import { HostExecBroker, sendHostExecControlRequest } from "./broker.ts";
import type { BrokerToGatewayMessage } from "./gateway_protocol.ts";
import {
  hostExecBrokerSocketPath,
  hostExecExecSocketPath,
  hostExecPendingSessionDir,
  hostExecSessionRegistryPath,
  listHostExecPendingEntries,
  resolveHostExecRuntimePaths,
  writeHostExecSessionRegistry,
} from "./registry.ts";
import type {
  ExecuteRequest,
  HostExecControlResponse,
  PendingListResponse,
} from "./types.ts";

type MaskedChunkMessage = Extract<
  BrokerToGatewayMessage,
  { type: "masked_chunk" }
>;
type BrokerTestResponse = BrokerToGatewayMessage | HostExecControlResponse;

/**
 * Test-only single-response reader for raw protocol frames. Production control
 * callers use `sendHostExecControlRequest`; this helper exists for malformed
 * gateway-channel frames and must not become a general broker API.
 */
async function sendTestRawRequest<
  T extends BrokerTestResponse = BrokerTestResponse,
>(socketPath: string, message: unknown): Promise<T> {
  const socket = await connectUnix(socketPath);
  try {
    await writeJsonLine(socket, message);
    const response = await readJsonLine(socket);
    if (!response) throw new Error("empty broker response");
    return JSON.parse(response) as T;
  } finally {
    socket.destroy();
  }
}

async function sendTestGatewayRequest<
  T extends BrokerToGatewayMessage = BrokerToGatewayMessage,
>(socketPath: string, request: ExecuteRequest): Promise<T> {
  return await sendTestRawRequest<T>(socketPath, {
    type: "execute",
    request,
  });
}

type HostExecConfigOverrides = Omit<Partial<HostExecConfig>, "prompt"> & {
  prompt?: Partial<HostExecConfig["prompt"]>;
};

interface StreamingResult {
  chunks: MaskedChunkMessage[];
  exitCode: number;
}

/**
 * Sends an execute request and reads the resulting NDJSON stream to
 * completion, collecting every `masked_chunk` message until the final `result`
 * line arrives. Unlike `sendTestGatewayRequest` (which reads a single
 * JSON line), this is required for execute requests because the broker now
 * streams stdout/stderr as they are produced instead of buffering a single
 * response.
 */
async function sendStreamingRequest(
  socketPath: string,
  message: ExecuteRequest,
): Promise<StreamingResult> {
  const socket = await connectUnix(socketPath);
  try {
    await writeJsonLine(socket, { type: "execute", request: message });
    const chunks: MaskedChunkMessage[] = [];
    let exitCode = -1;
    let buffer = "";
    let pump: Promise<void> | undefined;
    const readLine = async (): Promise<Record<string, unknown>> => {
      const line = await new Promise<string>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString();
          const nl = buffer.indexOf("\n");
          if (nl < 0) return;
          socket.off("data", onData);
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          resolve(line);
        };
        const existing = buffer.indexOf("\n");
        if (existing >= 0) {
          const line = buffer.slice(0, existing);
          buffer = buffer.slice(existing + 1);
          resolve(line);
          return;
        }
        socket.on("data", onData);
        socket.once("error", reject);
        socket.once("end", () => reject(new Error("gateway disconnected")));
      });
      return JSON.parse(line) as Record<string, unknown>;
    };
    while (true) {
      const msg = await readLine();
      if (msg.type === "start") {
        const start = msg as unknown as {
          argv0: string;
          args: string[];
          cwd: string;
          env: Record<string, string>;
          requestId: string;
        };
        pump = spawnFakeGatewayCommand(socket, start);
        continue;
      }
      if (msg.type === "masked_chunk") {
        chunks.push({
          type: "masked_chunk",
          requestId: String(msg.requestId),
          fd: Number(msg.fd) as 1 | 2,
          data: String(msg.data),
        });
      } else if (msg.type === "result") {
        exitCode = Number(msg.exitCode);
        await pump;
        break;
      } else if (msg.type === "fallback" || msg.type === "error") {
        if (pump) await pump.catch(() => {});
        throw new Error(
          `unexpected response: ${msg.type}: ${String(msg.message ?? "")}`,
        );
      }
    }
    return { chunks, exitCode };
  } finally {
    socket.destroy();
  }
}

/**
 * Like `sendStreamingRequest`, but does not reject when the stream
 * terminates with a `fallback`/`error` message — it returns the final
 * message's type/message instead. Used to assert on the broker's error
 * path without losing the error text.
 */
async function sendStreamingRequestRaw(
  socketPath: string,
  message: ExecuteRequest,
  options: { spawnedPid?: number } = {},
): Promise<{
  chunks: MaskedChunkMessage[];
  finalType: string;
  finalMessage?: string;
  exitCode?: number;
}> {
  const socket = await connectUnix(socketPath);
  try {
    await writeJsonLine(socket, { type: "execute", request: message });
    const chunks: MaskedChunkMessage[] = [];
    let finalType = "";
    let finalMessage: string | undefined;
    let exitCode: number | undefined;
    let text = "";
    let pump: Promise<void> | undefined;
    const readLine = async (): Promise<Record<string, unknown>> => {
      const line = await new Promise<string>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          text += chunk.toString();
          const nl = text.indexOf("\n");
          if (nl < 0) return;
          socket.off("data", onData);
          const line = text.slice(0, nl);
          text = text.slice(nl + 1);
          resolve(line);
        };
        const existing = text.indexOf("\n");
        if (existing >= 0) {
          const line = text.slice(0, existing);
          text = text.slice(existing + 1);
          resolve(line);
          return;
        }
        socket.on("data", onData);
        socket.once("error", reject);
        socket.once("end", () => reject(new Error("gateway disconnected")));
      });
      return JSON.parse(line) as Record<string, unknown>;
    };
    while (finalType === "") {
      const msg = await readLine();
      if (msg.type === "start") {
        if (options.spawnedPid !== undefined) {
          await writeJsonLine(socket, {
            type: "spawned",
            requestId: String(msg.requestId),
            pid: options.spawnedPid,
          });
          await writeJsonLine(socket, {
            type: "process_exit",
            requestId: String(msg.requestId),
            exitCode: 0,
          });
        } else {
          pump = spawnFakeGatewayCommand(socket, msg as never);
        }
        continue;
      }
      if (msg.type === "masked_chunk") {
        chunks.push({
          type: "masked_chunk",
          requestId: String(msg.requestId),
          fd: Number(msg.fd) as 1 | 2,
          data: String(msg.data),
        });
        continue;
      }
      if (msg.type === "kill") {
        // The broker asks the gateway to stop the command before publishing
        // its terminal error. A real gateway will finish the process group;
        // this fake command has already exited, so keep reading for error.
        continue;
      }
      finalType = String(msg.type);
      finalMessage =
        msg.message === undefined ? undefined : String(msg.message);
      exitCode = msg.exitCode === undefined ? undefined : Number(msg.exitCode);
    }
    await pump;
    return { chunks, finalType, finalMessage, exitCode };
  } finally {
    socket.destroy();
  }
}

interface FakeGatewayStart {
  argv0: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  requestId: string;
}

async function spawnFakeGatewayCommand(
  socket: import("node:net").Socket,
  start: FakeGatewayStart,
): Promise<void> {
  const proc = Bun.spawn([start.argv0, ...start.args], {
    cwd: start.cwd,
    env: start.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await writeJsonLine(socket, {
    type: "spawned",
    requestId: start.requestId,
    pid: proc.pid,
  });
  await Promise.all([
    relayGatewayStream(
      proc.stdout as ReadableStream<Uint8Array>,
      socket,
      start.requestId,
      1,
    ),
    relayGatewayStream(
      proc.stderr as ReadableStream<Uint8Array>,
      socket,
      start.requestId,
      2,
    ),
  ]);
  await writeJsonLine(socket, {
    type: "process_exit",
    requestId: start.requestId,
    exitCode: await proc.exited,
  });
}

async function relayGatewayStream(
  stream: ReadableStream<Uint8Array>,
  socket: import("node:net").Socket,
  requestId: string,
  fd: 1 | 2,
): Promise<void> {
  for await (const chunk of stream) {
    await writeJsonLine(socket, {
      type: "raw_chunk",
      requestId,
      fd,
      data: Buffer.from(chunk).toString("base64"),
    });
  }
}

/**
 * Reassembles stdout from a streaming result. Each chunk's `data` field is
 * independently base64-encoded, so each chunk must be decoded on its own
 * and the decoded strings concatenated — concatenating the base64 strings
 * first and decoding once would corrupt the output.
 */
function collectStdout(result: StreamingResult): string {
  return result.chunks
    .filter((c) => c.fd === 1)
    .map((c) => Buffer.from(c.data, "base64").toString("utf-8"))
    .join("");
}

function makeConfig(overrides: HostExecConfigOverrides = {}): HostExecConfig {
  return {
    prompt: {
      enable: true,
      timeoutSeconds: 30,
      defaultScope: "capability",
      notify: "off",
      ...(overrides.prompt ?? {}),
    },
    secrets: overrides.secrets ?? {},
    rules: overrides.rules ?? [],
  };
}

function request(
  args: string[],
  cwd: string,
  requestId = `req_${crypto.randomUUID()}`,
  argv0 = "node",
): ExecuteRequest {
  return {
    version: 2,
    type: "execute",
    sessionId: "sess_test",
    requestId,
    argv0,
    args,
    cwd,
    tty: false,
    stdinMode: "none",
  };
}

test("HostExecBroker: falls back when no rule matches", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const response = await sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('x')"], process.cwd()),
    );
    expect(response.type).toEqual("fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: preserves a coalesced frame after the execute request", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-any",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  const socket = await connectUnix(execSocketPath);
  try {
    let received = "";
    const readGatewayLine = async (): Promise<Record<string, unknown>> => {
      const line = await new Promise<string>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          received += chunk.toString();
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          socket.off("data", onData);
          const result = received.slice(0, newline);
          received = received.slice(newline + 1);
          resolve(result);
        };
        const existing = received.indexOf("\n");
        if (existing >= 0) {
          const result = received.slice(0, existing);
          received = received.slice(existing + 1);
          resolve(result);
          return;
        }
        socket.on("data", onData);
        socket.once("error", reject);
        socket.once("end", () => reject(new Error("gateway disconnected")));
      });
      return JSON.parse(line) as Record<string, unknown>;
    };
    const execute = {
      type: "execute" as const,
      request: request(["-e", "process.exit(0)"], workspace, "req_coalesced"),
    };
    const cancelled = {
      type: "cancelled" as const,
      requestId: "req_coalesced",
      reason: "gateway disconnected",
    };
    socket.write(`${JSON.stringify(execute)}\n${JSON.stringify(cancelled)}\n`);

    expect(await readGatewayLine()).toMatchObject({
      type: "start",
      requestId: "req_coalesced",
    });
    expect(await readGatewayLine()).toMatchObject({
      type: "kill",
      requestId: "req_coalesced",
      signal: "SIGTERM",
    });
    const terminal = await Promise.race([
      readGatewayLine(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(terminal).toMatchObject({
      type: "error",
      requestId: "req_coalesced",
    });
  } finally {
    socket.destroy();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: rejects duplicate request IDs while direct execution is active", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-any",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  const firstSocket = await connectUnix(execSocketPath);
  firstSocket.on("error", () => {});
  try {
    const requestId = "req_duplicate_direct";
    await writeJsonLine(firstSocket, {
      type: "execute",
      request: request(["-e", "process.exit(0)"], workspace, requestId),
    });
    const start = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let text = "";
        const onData = (chunk: Buffer) => {
          text += chunk.toString();
          const newline = text.indexOf("\n");
          if (newline < 0) return;
          firstSocket.off("data", onData);
          try {
            resolve(
              JSON.parse(text.slice(0, newline)) as Record<string, unknown>,
            );
          } catch (error) {
            reject(error);
          }
        };
        firstSocket.on("data", onData);
        firstSocket.once("error", reject);
      },
    );
    expect(start).toMatchObject({ type: "start", requestId });

    const duplicate = await sendStreamingRequestRaw(
      execSocketPath,
      request(["-e", "process.exit(0)"], workspace, requestId),
    );
    expect(duplicate.finalType).toBe("error");
    expect(duplicate.finalMessage).toContain("duplicate active request ID");

    firstSocket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Once the original connection is gone, its reservation is released and
    // the same ID can be used for a fresh request without an orphaned owner.
    const reused = await sendStreamingRequestRaw(
      execSocketPath,
      request(["-e", "process.exit(0)"], workspace, requestId),
    );
    expect(reused.finalType).toBe("result");
  } finally {
    firstSocket.destroy();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: rejects duplicate request IDs across approval groups", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "deny",
        },
        {
          id: "node-version",
          match: { argv0: "node", argRegex: "^--version\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  const firstSocket = await connectUnix(execSocketPath);
  firstSocket.on("error", () => {});
  try {
    const requestId = "req_duplicate_groups";
    await writeJsonLine(firstSocket, {
      type: "execute",
      request: request(["-e", "console.log('first')"], workspace, requestId),
    });
    const pending = await waitForPendingEntries(paths, 1);
    expect(pending).toHaveLength(1);
    expect(pending[0].ruleId).toBe("node-eval");
    expect(pending[0].args).toEqual(["-e", "console.log('first')"]);

    const duplicate = await sendStreamingRequestRaw(
      execSocketPath,
      request(["--version"], workspace, requestId),
    );
    expect(duplicate.finalType).toBe("error");
    expect(duplicate.finalMessage).toContain("duplicate active request ID");
    const stillPending = await listHostExecPendingEntries(paths, "sess_test");
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].ruleId).toBe("node-eval");

    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId,
    });
    await waitForNoPendingEntries(paths);
  } finally {
    firstSocket.destroy();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: records command process lifecycle diagnostics", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_diagnostics",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-any",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_diagnostics");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_diagnostics");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(
        ["-e", "process.stdout.write('ok')"],
        workspace,
        "req_diagnostics",
      ),
    );
    expect(result.exitCode).toBe(0);

    const contents = await readFile(
      path.join(runtimeDir, "diagnostics", "sess_diagnostics.jsonl"),
      "utf8",
    );
    const events = contents
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const spawned = events.find(
      (event) =>
        event.event === "command_spawned" &&
        event.requestId === "req_diagnostics",
    );
    const exited = events.find(
      (event) =>
        event.event === "command_exited" &&
        event.requestId === "req_diagnostics",
    );
    expect(spawned.process.pid).toBeGreaterThan(0);
    expect(spawned.process.processGroupId).toBeGreaterThan(0);
    expect(spawned.command).toBe("node");
    expect(spawned.argumentCount).toBe(2);
    expect(exited.exitCode).toBe(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: records command exit even when process identity is unavailable", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_null_identity",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "true",
          match: { argv0: "true" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(
    paths,
    "sess_null_identity",
  );
  const execSocketPath = hostExecExecSocketPath(paths, "sess_null_identity");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequestRaw(
      execSocketPath,
      request([], workspace, "req_null_identity", "true"),
      { spawnedPid: 2_147_483_647 },
    );
    expect(result.finalType).toBe("result");
    const contents = await readFile(
      path.join(runtimeDir, "diagnostics", "sess_null_identity.jsonl"),
      "utf8",
    );
    const exited = contents
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find(
        (event) =>
          event.event === "command_exited" &&
          event.requestId === "req_null_identity",
      );
    expect(exited).toBeDefined();
    expect(exited.exitCode).toBe(0);
    expect(exited.process).toBe(null);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: prompts and resumes after approve", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-audit-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    auditDir,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const execPromise = sendStreamingRequest(
      execSocketPath,
      request(["-e", "console.log('approved')"], workspace, "req_approve"),
    );
    const earlyResponse = await Promise.race([
      execPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (earlyResponse !== null) {
      throw new Error(
        `request resolved too early: ${JSON.stringify(earlyResponse)}`,
      );
    }
    const pending = await waitForPendingEntries(paths, 1);
    expect(pending.length).toEqual(1);
    expect(pending[0].ruleId).toEqual("node-eval");
    await sendHostExecControlRequest(controlSocketPath, {
      type: "approve",
      requestId: "req_approve",
    });
    const result = await execPromise;
    expect(result.exitCode).toEqual(0);
    expect(collectStdout(result).trim()).toEqual("approved");

    const logs = await queryAuditLogs({ domain: "hostexec" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("allow");
    expect(logs[0].reason).toEqual("approved-by-user");
    expect(logs[0].requestId).toEqual("req_approve");
    expect(logs[0].command!).toMatch(/^node -e /);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: pending request can be denied via broker", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-audit-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    auditDir,
    hostexec: makeConfig({
      prompt: {
        enable: true,
        timeoutSeconds: 30,
        defaultScope: "capability",
        notify: "off",
      },
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const executePromise = sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('x')"], workspace, "req_deny"),
    );
    const pending = await waitForPendingEntries(paths, 1);
    expect(pending.length).toEqual(1);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_deny",
    });
    const response = await executePromise;
    expect(response.type).toEqual("error");
    if (response.type === "error") {
      expect(response.message).toEqual("permission denied by user");
    }

    const logs = await queryAuditLogs({ domain: "hostexec" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("denied-by-user");
    expect(logs[0].requestId).toEqual("req_deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: disconnect during policy resolution clears pending state", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  const socket = await connectUnix(execSocketPath);
  socket.on("error", () => {});
  try {
    await writeJsonLine(socket, {
      type: "execute",
      request: request(
        ["-e", "console.log('never')"],
        workspace,
        "req_disconnect",
      ),
    });
    // Let the server consume the execute frame, then disconnect while the
    // asynchronous policy/secret/cwd work is still in flight.
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await listHostExecPendingEntries(paths, "sess_test")).toHaveLength(
      0,
    );
  } finally {
    socket.destroy();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: cancellation removes pending request before approval", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  const socket = await connectUnix(execSocketPath);
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  try {
    const requestId = "req_cancel_pending";
    await writeJsonLine(socket, {
      type: "execute",
      request: request(["-e", "console.log('never')"], workspace, requestId),
    });
    await waitForPendingEntries(paths, 1);
    await writeJsonLine(socket, {
      type: "cancelled",
      requestId,
      reason: "client cancelled approval",
    });
    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("gateway socket did not close")),
          1_000,
        ),
      ),
    ]);
    await waitForNoPendingEntries(paths);
    const approval = await sendHostExecControlRequest(controlSocketPath, {
      type: "approve",
      requestId,
    });
    expect(approval.type).toBe("error");
  } finally {
    socket.destroy();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: cancellation and approval race cleanup is idempotent", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  const socket = await connectUnix(execSocketPath);
  socket.on("error", () => {});
  try {
    const requestId = "req_cancel_approve_race";
    await writeJsonLine(socket, {
      type: "execute",
      request: request(["-e", "process.exit(0)"], workspace, requestId),
    });
    await waitForPendingEntries(paths, 1);
    await writeJsonLine(socket, {
      type: "cancelled",
      requestId,
      reason: "approval race",
    });
    // Give the read monitor the first chance, then deliberately issue the
    // control decision. Either ordering must leave the same clean state.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const approval = await sendHostExecControlRequest(controlSocketPath, {
      type: "approve",
      requestId,
    });
    expect(["ack", "error"]).toContain(approval.type);
    await waitForNoPendingEntries(paths);
  } finally {
    socket.destroy();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: internal gateway channel cannot approve a pending request", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // A gateway connection submits a request that goes to pending.
    const execPromise = sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('x')"], workspace, "req_self_approve"),
    );
    await waitForPendingEntries(paths, 1);

    // A gateway connection cannot drive control operations. The broker
    // rejects the first frame because it is not an execute envelope and
    // closes the connection without disclosing pending state.
    await expect(
      sendTestRawRequest<BrokerTestResponse>(execSocketPath, {
        type: "approve",
        requestId: "req_self_approve",
      }),
    ).rejects.toThrow(/empty broker response|socket|connection/i);

    // The execute request is still pending (was not approved).
    const early = await Promise.race([
      execPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 150)),
    ]);
    expect(early).toEqual(null);
    const stillPending = await listHostExecPendingEntries(paths, "sess_test");
    expect(
      stillPending.some((e) => e.requestId === "req_self_approve"),
    ).toEqual(true);

    // Clean up: deny via the control channel and drain.
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_self_approve",
    });
    await execPromise;
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: control channel rejects execute", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-any",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const response = await sendTestRawRequest<BrokerTestResponse>(
      controlSocketPath,
      request(["-e", "console.log('ok')"], workspace, "req_control_exec"),
    );
    expect(response.type).toEqual("error");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: capability key differs by secret reference and cwd", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const oldTokenA = process.env.TOKEN_A;
  const oldTokenB = process.env.TOKEN_B;
  process.env.TOKEN_A = "token-a";
  process.env.TOKEN_B = "token-b";
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      secrets: {
        token_a: { from: "env:TOKEN_A", required: true },
        token_b: { from: "env:TOKEN_B", required: true },
      },
      rules: [
        {
          id: "deno-secret-a",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: { TOKEN: "secret:token_a" },
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
        {
          id: "deno-secret-b",
          match: { argv0: "node", argRegex: "^fmt\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: { TOKEN: "secret:token_b" },
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const firstPromise = sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('a')"], workspace, "req_a"),
    );
    const nested = `${workspace}/nested`;
    await mkdir(nested, { recursive: true });
    const secondPromise = sendTestGatewayRequest(
      execSocketPath,
      request(["fmt", "--help"], nested, "req_b"),
    );
    const earlyFirst = await Promise.race([
      firstPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    const earlySecond = await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (earlyFirst !== null || earlySecond !== null) {
      throw new Error(
        `request resolved too early: ${JSON.stringify([
          earlyFirst,
          earlySecond,
        ])}`,
      );
    }
    const entries = await waitForPendingCount(paths, 2);
    expect(entries[0].approvalKey).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[1].approvalKey).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0].approvalKey === entries[1].approvalKey).toEqual(false);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_a",
    });
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_b",
    });
    expect((await firstPromise).type).toEqual("error");
    expect((await secondPromise).type).toEqual("error");
  } finally {
    if (oldTokenA !== undefined) process.env.TOKEN_A = oldTokenA;
    else delete process.env.TOKEN_A;
    if (oldTokenB !== undefined) process.env.TOKEN_B = oldTokenB;
    else delete process.env.TOKEN_B;
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: argv0-only rule matches any args", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-any",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(["-e", "console.log('ok')"], workspace, "req_any"),
    );
    expect(result.exitCode).toEqual(0);
    expect(collectStdout(result).trim()).toEqual("ok");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: PATH rule executes basename when request argv0 is wrapper path", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "sh-any",
          match: { argv0: "sh" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(
        ["-c", "printf ok"],
        workspace,
        "req_sh_wrapper",
        "/opt/nas/hostexec/bin/sh",
      ),
    );
    expect(result.exitCode).toEqual(0);
    expect(collectStdout(result)).toEqual("ok");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: relative rule executes original relative argv0", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const scriptPath = `${workspace}/gradlew`;
  await writeFile(scriptPath, "#!/bin/sh\nprintf gradle-ok\n");
  await chmod(scriptPath, 0o755);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "gradlew-any",
          match: { argv0: "./gradlew" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request([], workspace, "req_gradlew", "./gradlew"),
    );
    expect(result.exitCode).toEqual(0);
    expect(collectStdout(result)).toEqual("gradle-ok");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: absolute rule executes exact absolute binary path", async () => {
  // Verify that a rule with an absolute argv0 executes that exact binary on
  // the host and does not degrade to a basename/PATH lookup.
  // We use a temp script at a known absolute path to avoid platform-specific
  // assumptions about /usr/bin/true availability inside the test sandbox.
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  // Create a helper script inside workspace whose absolute path we control.
  const helperScript = `${workspace}/helper.sh`;
  await writeFile(helperScript, "#!/bin/sh\nprintf absolute-ok\n");
  await chmod(helperScript, 0o755);

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "helper-absolute",
          match: { argv0: helperScript },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // Request must use the exact absolute path — broker must execute it directly.
    const result = await sendStreamingRequest(
      execSocketPath,
      request([], workspace, "req_helper_abs", helperScript),
    );
    expect(result.exitCode).toEqual(0);
    expect(collectStdout(result)).toEqual("absolute-ok");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: absolute rule does not match bare-name invocation", async () => {
  // A rule matching an absolute path should NOT intercept a bare-name invocation.
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const helperScript = `${workspace}/helper.sh`;
  await writeFile(helperScript, "#!/bin/sh\nexit 0\n");
  await chmod(helperScript, 0o755);

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "helper-absolute",
          match: { argv0: helperScript },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const response = await sendTestGatewayRequest(
      execSocketPath,
      request([], workspace, "req_helper_bare", "helper.sh"),
    );
    // Bare 'helper.sh' should not match the absolute rule → fallback
    expect(response.type).toEqual("fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: argv0-only rule also matches no-args command", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "true-any",
          match: { argv0: "true" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const response = await sendStreamingRequest(
      execSocketPath,
      request([], workspace, "req_true_noargs", "true"),
    );
    expect(response.exitCode).toEqual(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: rejects cwd outside workspace with workspace-only mode", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const outsideDir = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-outside-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-ws-only",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const response = await sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('x')"], outsideDir, "req_cwd"),
    );
    expect(response.type).toEqual("error");
    if (response.type === "error") {
      expect(response.message).toMatch(/outside workspace/);
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: allows cwd in session tmp with workspace-or-session-tmp mode", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const sessionTmpDir = `${runtimeDir}/tmp`;
  await mkdir(sessionTmpDir, { recursive: true });
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-ws-tmp",
          match: { argv0: "node" },
          cwd: { mode: "workspace-or-session-tmp", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(["-e", "console.log('ok')"], sessionTmpDir, "req_tmp"),
    );
    expect(result.exitCode).toEqual(0);
    expect(collectStdout(result).trim()).toEqual("ok");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: fallback deny returns error for unmatched command", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-audit-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    auditDir,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-deny",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "any", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "deny",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // Unmatched command: no rule for "fmt"
    const fallbackResponse = await sendTestGatewayRequest(
      execSocketPath,
      request(["fmt", "--help"], process.cwd(), "req_unmatched"),
    );
    expect(fallbackResponse.type).toEqual("fallback");

    // Matched command with approval: deny
    const denyResponse = await sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('x')"], process.cwd(), "req_deny"),
    );
    expect(denyResponse.type).toEqual("error");
    if (denyResponse.type === "error") {
      expect(denyResponse.message).toMatch(/permission denied/);
    }

    const logs = await queryAuditLogs({ domain: "hostexec" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("policy-deny");
    expect(logs[0].requestId).toEqual("req_deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: capability key differs by inheritEnv", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-minimal",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
        {
          id: "deno-with-keys",
          match: { argv0: "node", argRegex: "^fmt\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: ["SSH_AUTH_SOCK"] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const firstPromise = sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('a')"], workspace, "req_ie_a"),
    );
    const secondPromise = sendTestGatewayRequest(
      execSocketPath,
      request(["fmt", "--help"], workspace, "req_ie_b"),
    );
    await Promise.race([
      firstPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    const entries = await waitForPendingCount(paths, 2);
    expect(entries[0].approvalKey === entries[1].approvalKey).toEqual(false);
    // Clean up
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_ie_a",
    });
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_ie_b",
    });
    await firstPromise;
    await secondPromise;
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: scope once does not cache approval key", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // First request: approve with scope "once"
    const firstPromise = sendStreamingRequest(
      execSocketPath,
      request(["-e", "console.log('first')"], workspace, "req_once_1"),
    );
    await waitForPendingEntries(paths, 1);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "approve",
      requestId: "req_once_1",
      scope: "once",
    });
    const firstResult = await firstPromise;
    expect(firstResult.exitCode).toEqual(0);
    expect(collectStdout(firstResult).trim()).toEqual("first");

    // Second identical request (same args) should go to pending again (not auto-approved)
    const secondPromise = sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('first')"], workspace, "req_once_2"),
    );
    const earlyResponse = await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    expect(earlyResponse).toEqual(null);

    // Clean up
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_once_2",
    });
    await secondPromise;
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: scope capability caches approval key", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // First request: approve with scope "capability"
    const firstPromise = sendStreamingRequest(
      execSocketPath,
      request(["-e", "console.log('first')"], workspace, "req_cap_1"),
    );
    await waitForPendingEntries(paths, 1);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "approve",
      requestId: "req_cap_1",
      scope: "capability",
    });
    const firstResult = await firstPromise;
    expect(firstResult.exitCode).toEqual(0);

    // Second identical request (same args) should be auto-approved (not pending)
    const secondResult = await sendStreamingRequest(
      execSocketPath,
      request(["-e", "console.log('first')"], workspace, "req_cap_2"),
    );
    expect(secondResult.exitCode).toEqual(0);
    expect(collectStdout(secondResult).trim()).toEqual("first");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: defaultScope once used when no explicit scope", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      prompt: { defaultScope: "once" },
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // First request: approve without explicit scope (defaultScope = "once")
    const firstPromise = sendStreamingRequest(
      execSocketPath,
      request(["-e", "console.log('first')"], workspace, "req_def_1"),
    );
    await waitForPendingEntries(paths, 1);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "approve",
      requestId: "req_def_1",
    });
    const firstResult = await firstPromise;
    expect(firstResult.exitCode).toEqual(0);

    // Second request (same args) should go to pending (defaultScope was "once", so not cached)
    const secondPromise = sendTestGatewayRequest(
      execSocketPath,
      request(["-e", "console.log('first')"], workspace, "req_def_2"),
    );
    const earlyResponse = await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    expect(earlyResponse).toEqual(null);

    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_def_2",
    });
    await secondPromise;
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: streaming produces chunks for multi-line output", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-any",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(
        [
          "-e",
          "console.log('line1'); console.error('err1'); console.log('line2')",
        ],
        workspace,
        "req_stream",
      ),
    );
    expect(result.exitCode).toEqual(0);
    expect(result.chunks.length).toBeGreaterThan(0);
    const stdout = collectStdout(result);
    expect(stdout).toContain("line1");
    expect(stdout).toContain("line2");
    const stderr = result.chunks
      .filter((c) => c.fd === 2)
      .map((c) => Buffer.from(c.data, "base64").toString("utf-8"))
      .join("");
    expect(stderr).toContain("err1");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: streaming produces zero chunks for silent command", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "true-any",
          match: { argv0: "true" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request([], workspace, "req_silent", "true"),
    );
    expect(result.exitCode).toEqual(0);
    expect(result.chunks.length).toEqual(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: secret env binding injects resolved value into command", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const oldToken = process.env.HOSTEXEC_TEST_TOKEN;
  process.env.HOSTEXEC_TEST_TOKEN = "test-secret-42";
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      secrets: {
        test_token: { from: "env:HOSTEXEC_TEST_TOKEN", required: true },
      },
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: { TOKEN: "secret:test_token" },
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(
        ["-e", "console.log(process.env['TOKEN'])"],
        workspace,
        "req_secret",
      ),
    );
    expect(result.exitCode).toEqual(0);
    expect(collectStdout(result).trim()).toEqual("test-secret-42");
  } finally {
    if (oldToken !== undefined) process.env.HOSTEXEC_TEST_TOKEN = oldToken;
    else delete process.env.HOSTEXEC_TEST_TOKEN;
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

async function waitForPendingEntries(
  paths: Awaited<ReturnType<typeof resolveHostExecRuntimePaths>>,
  count: number,
): Promise<PendingListResponse["items"]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = await listHostExecPendingEntries(paths, "sess_test");
    if (entries.length >= count) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for hostexec pending entry");
}

async function waitForPendingCount(
  paths: Awaited<ReturnType<typeof resolveHostExecRuntimePaths>>,
  count: number,
) {
  return await waitForPendingEntries(paths, count);
}

async function waitForNoPendingEntries(
  paths: Awaited<ReturnType<typeof resolveHostExecRuntimePaths>>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await listHostExecPendingEntries(paths, "sess_test");
    if (entries.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for hostexec pending entries to clear");
}

async function processFdCount(): Promise<number> {
  return (await readdir("/proc/self/fd")).length;
}

async function waitForProcessFdBaseline(
  baseline: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processFdCount()) <= baseline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await processFdCount()).toBeLessThanOrEqual(baseline);
}

test("HostExecBroker: close tears down a pending approval session", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-close-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-close-workspace-"),
  );
  const sessionId = "sess_test";
  const broker = new HostExecBroker({
    paths,
    sessionId,
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: path.join(runtimeDir, "tmp"),
    hostexec: makeConfig({
      rules: [
        {
          id: "node-close-pending",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, sessionId);
  const execSocketPath = hostExecExecSocketPath(paths, sessionId);
  const registryPath = hostExecSessionRegistryPath(paths, sessionId);
  const pendingDir = hostExecPendingSessionDir(paths, sessionId);
  let handler: import("node:net").Socket | undefined;
  let brokerClosed = false;
  try {
    await broker.start(execSocketPath, controlSocketPath);
    await writeHostExecSessionRegistry(paths, {
      version: 1,
      sessionId,
      brokerSocket: controlSocketPath,
      profileName: "test",
      createdAt: new Date().toISOString(),
      pid: process.pid,
    });

    const fdBaseline = await processFdCount();
    handler = await connectUnix(execSocketPath);
    handler.on("error", () => {});
    const handlerClosed = new Promise<void>((resolve) =>
      handler?.once("close", () => resolve()),
    );
    await writeJsonLine(handler, {
      type: "execute",
      request: request(
        ["-e", "console.log('must-not-start')"],
        workspace,
        "req_close_pending",
      ),
    });

    const pendingDeadline = Date.now() + 5_000;
    while (Date.now() < pendingDeadline) {
      if ((await broker.listPending()).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await broker.listPending()).toHaveLength(1);
    expect(await listHostExecPendingEntries(paths, sessionId)).toHaveLength(1);

    const responsePromise = readJsonLine(handler);
    await broker.close();
    brokerClosed = true;
    const responseLine = await Promise.race([
      responsePromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("pending close response timed out")),
          1_000,
        ),
      ),
    ]);
    expect(JSON.parse(responseLine!)).toMatchObject({
      type: "error",
      requestId: "req_close_pending",
      message: "hostexec broker closed",
    });
    await Promise.race([
      handlerClosed,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("pending handler did not close")),
          1_000,
        ),
      ),
    ]);

    // The public pending view and the control endpoint both prove that the
    // waiter/request maps are no longer reachable after service close.
    expect(await broker.listPending()).toHaveLength(0);
    expect(await listHostExecPendingEntries(paths, sessionId)).toHaveLength(0);
    await expect(
      sendHostExecControlRequest(controlSocketPath, { type: "list_pending" }),
    ).rejects.toThrow();
    await expect(stat(registryPath)).rejects.toThrow();
    await expect(stat(execSocketPath)).rejects.toThrow();
    await expect(stat(controlSocketPath)).rejects.toThrow();
    await expect(stat(pendingDir)).rejects.toThrow();

    // The handler's accepted transport descriptor is the received gateway
    // FD in this lifecycle test. It must return to the process baseline.
    await waitForProcessFdBaseline(fdBaseline);
  } finally {
    handler?.destroy();
    if (!brokerClosed) await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: isolates sockets per session under 0o700 subdirs", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);

  const brokerA = new HostExecBroker({
    paths,
    sessionId: "sess_alpha",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });
  const brokerB = new HostExecBroker({
    paths,
    sessionId: "sess_beta",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });

  const controlA = hostExecBrokerSocketPath(paths, "sess_alpha");
  const controlB = hostExecBrokerSocketPath(paths, "sess_beta");
  const execA = hostExecExecSocketPath(paths, "sess_alpha");
  const execB = hostExecExecSocketPath(paths, "sess_beta");

  try {
    await brokerA.start(execA, controlA);
    await brokerB.start(execB, controlB);

    expect(path.dirname(controlA)).toBe(
      path.join(paths.brokersDir, "sess_alpha"),
    );
    expect(path.dirname(controlB)).toBe(
      path.join(paths.brokersDir, "sess_beta"),
    );
    expect(path.basename(controlA)).toBe("sock");

    const dirA = await stat(path.dirname(controlA));
    const dirB = await stat(path.dirname(controlB));
    expect(dirA.mode & 0o777).toBe(0o700);
    expect(dirB.mode & 0o777).toBe(0o700);

    const entries = (await readdir(paths.brokersDir)).sort();
    expect(entries).toEqual(["sess_alpha", "sess_beta"]);

    // Each session's subdir holds its own control socket plus the `exec/`
    // subdir carrying the container-facing exec socket — sibling sessions are
    // not reachable by name from the other subdir.
    const inA = (await readdir(path.dirname(controlA))).sort();
    const inB = (await readdir(path.dirname(controlB))).sort();
    expect(inA).toEqual(["exec", "sock"]);
    expect(inB).toEqual(["exec", "sock"]);
    // The exec socket lives under the `exec/` subdir of each session.
    expect(path.basename(execA)).toBe("sock");
    expect(path.dirname(execA)).toBe(
      path.join(paths.brokersDir, "sess_alpha", "exec"),
    );
  } finally {
    await brokerA.close();
    await brokerB.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: masks secrets in streaming output when maskFilter configured", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );

  // Write a secrets frame file with "SUPERSECRET" as the secret
  const { encodeMaskSecrets } = await import(
    "../stages/maskfs/secrets_frame.ts"
  );
  const frame = encodeMaskSecrets(["SUPERSECRET"]);
  const secretsFramePath = path.join(runtimeDir, "mask-secrets.frame");
  await writeFile(secretsFramePath, frame);

  // Resolve the mask-filter binary
  const { resolveMaskFilterBinPath } = await import(
    "../stages/maskfs/mask_filter_path.ts"
  );
  const binaryPath = await resolveMaskFilterBinPath();
  if (!binaryPath) {
    console.warn("Skipping mask-filter test: binary not found");
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "echo",
          match: { argv0: "echo" },
          cwd: { mode: "any", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
    maskFilter: { binaryPath, secretsFramePath },
  });

  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await mkdir(`${runtimeDir}/tmp`, { recursive: true });
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(["hello SUPERSECRET world"], workspace, undefined, "echo"),
    );
    const stdout = collectStdout(result);
    expect(stdout).not.toContain("SUPERSECRET");
    expect(stdout).toContain("hello");
    expect(stdout).toContain("world");
    expect(result.exitCode).toBe(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: does not mask when maskFilter is not configured", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "echo",
          match: { argv0: "echo" },
          cwd: { mode: "any", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await mkdir(`${runtimeDir}/tmp`, { recursive: true });
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(["hello SUPERSECRET world"], workspace, undefined, "echo"),
    );
    const stdout = collectStdout(result);
    expect(stdout).toContain("SUPERSECRET");
    expect(result.exitCode).toBe(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: surfaces an error instead of a truncated result when the mask filter subprocess fails", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );

  // Point the mask filter at a secrets frame file that does not exist, so
  // nas-mask-filter fails to read it and exits non-zero (see
  // src/mask-filter/mask_filter.zig: readSecretsFromFile -> exit code 1 on
  // read failure). This simulates the frame being deleted/corrupted
  // mid-session: the broker must surface this as an `error` response
  // instead of silently reporting the real command's (successful) exit
  // code with truncated/corrupted output.
  const { resolveMaskFilterBinPath } = await import(
    "../stages/maskfs/mask_filter_path.ts"
  );
  const binaryPath = await resolveMaskFilterBinPath();
  if (!binaryPath) {
    console.warn("Skipping mask-filter failure test: binary not found");
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    return;
  }
  const missingFramePath = path.join(runtimeDir, "does-not-exist.frame");

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "echo",
          match: { argv0: "echo" },
          cwd: { mode: "any", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
    maskFilter: { binaryPath, secretsFramePath: missingFramePath },
  });

  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await mkdir(`${runtimeDir}/tmp`, { recursive: true });
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequestRaw(
      execSocketPath,
      request(["hello world"], workspace, undefined, "echo"),
    );
    expect(result.finalType).toEqual("error");
    expect(result.finalMessage).toMatch(
      /nas-mask-filter exited (before command completion )?with code/,
    );
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: records command exit before mask-filter finish failure", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const filterPath = path.join(runtimeDir, "late-failing-filter.sh");
  await writeFile(filterPath, "#!/bin/sh\ncat >/dev/null\nexit 7\n");
  await chmod(filterPath, 0o755);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_filter_exit",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "true",
          match: { argv0: "true" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
    maskFilter: {
      binaryPath: filterPath,
      secretsFramePath: path.join(runtimeDir, "unused.frame"),
    },
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_filter_exit");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_filter_exit");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequestRaw(
      execSocketPath,
      request([], workspace, "req_filter_exit", "true"),
    );
    expect(result.finalType).toBe("error");
    const contents = await readFile(
      path.join(runtimeDir, "diagnostics", "sess_filter_exit.jsonl"),
      "utf8",
    );
    const exited = contents
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find(
        (event) =>
          event.event === "command_exited" &&
          event.requestId === "req_filter_exit",
      );
    expect(exited).toBeDefined();
    expect(exited.exitCode).toBe(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: close() removes both socket and session subdir", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_cleanup",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_cleanup");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_cleanup");
  try {
    await broker.start(execSocketPath, controlSocketPath);
    expect(await readdir(paths.brokersDir)).toEqual(["sess_cleanup"]);
    await broker.close();
    expect(await readdir(paths.brokersDir)).toEqual([]);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: allow rule prompts when the target file changed since start", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-integ-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const scriptPath = path.join(runtimeDir, "tool.sh");
  await writeFile(scriptPath, "#!/bin/sh\necho original\n");

  const config: HostExecConfig = {
    prompt: {
      enable: true,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "off",
    },
    secrets: {},
    rules: [
      {
        id: "tool",
        match: { argv0: scriptPath },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "deny",
      },
    ],
  };

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_integ",
    profileName: "test",
    notify: "off",
    workspaceRoot: runtimeDir,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: config,
    integrityTargets: [scriptPath],
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_integ");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_integ");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // 差し替え: baseline 取得後に同じパスの中身を変える
    await writeFile(scriptPath, "#!/bin/sh\necho SWAPPED\n");

    // execute を送る。allow ルールでも即実行されず承認待ちに入るため、応答は
    // 返らない（このソケットは開いたまま pending となる）。
    const execSocket = await connectUnix(execSocketPath);
    await writeJsonLine(execSocket, {
      type: "execute",
      request: {
        version: 2,
        type: "execute",
        sessionId: "sess_integ",
        requestId: "req_1",
        argv0: scriptPath,
        args: [],
        cwd: runtimeDir,
        tty: false,
        stdinMode: "none",
      },
    });

    // control 側で pending を列挙し、integrityChanged が立つことを確認する。
    // pending 生成は非同期なので短くポーリングする。
    let hit: { requestId: string; integrityChanged?: boolean } | undefined;
    for (let i = 0; i < 50; i++) {
      const res = (await sendHostExecControlRequest(controlSocketPath, {
        type: "list_pending",
      })) as PendingListResponse;
      hit = res.items.find((it) => it.requestId === "req_1");
      if (hit) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hit).toBeDefined();
    expect(hit?.integrityChanged).toBe(true);

    // pending グループを deny で正常に解消してから teardown する。exec ソケットを
    // 開いたまま破棄すると、ブローカー側が pending waiter へエラーを書き込む際に
    // 相手が既に消えたソケットへの書き込みが完了しない（write callback が発火
    // しない）ことがあり、broker.close() が無限に待機してしまうため。deny 応答の
    // 読み取りリスナーは deny 送信前に登録する（送信後に登録すると、データが
    // 既に到着済みでも取りこぼすことがあるため）。
    const responsePromise = readJsonLine(execSocket);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_1",
    });
    await responsePromise;
    execSocket.destroy();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: approved capability cache does not bypass a changed integrity target", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-integ-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const scriptPath = path.join(workspace, "tool.sh");
  await writeFile(scriptPath, "#!/bin/sh\necho original\n");
  await chmod(scriptPath, 0o755);

  const config: HostExecConfig = {
    prompt: {
      enable: true,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "off",
    },
    secrets: {},
    rules: [
      {
        id: "tool-prompt",
        match: { argv0: scriptPath },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "prompt",
        fallback: "deny",
      },
    ],
  };

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_integ2",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: config,
    integrityTargets: [scriptPath],
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_integ2");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_integ2");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // 最初の execute: prompt ルールなので pending になる。capability スコープで
    // 承認し、approvedKeys にキャッシュされることを前提とする。sessionId は
    // ブローカー構築時と同じ "sess_integ2" を使う（waitForPendingEntries は
    // "sess_test" 固定のため使えず、list_pending で直接確認する）。
    const firstPromise = sendStreamingRequest(execSocketPath, {
      version: 2,
      type: "execute",
      sessionId: "sess_integ2",
      requestId: "req_cache_1",
      argv0: scriptPath,
      args: [],
      cwd: workspace,
      tty: false,
      stdinMode: "none",
    });

    let firstHit: { requestId: string } | undefined;
    for (let i = 0; i < 50; i++) {
      const res = (await sendHostExecControlRequest(controlSocketPath, {
        type: "list_pending",
      })) as PendingListResponse;
      firstHit = res.items.find((it) => it.requestId === "req_cache_1");
      if (firstHit) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(firstHit).toBeDefined();

    await sendHostExecControlRequest(controlSocketPath, {
      type: "approve",
      requestId: "req_cache_1",
      scope: "capability",
    });
    const firstResult = await firstPromise;
    expect(firstResult.exitCode).toEqual(0);
    expect(collectStdout(firstResult).trim()).toEqual("original");

    // baseline snapshot 済み・承認キャッシュ済みの後にファイル内容を差し替える。
    await writeFile(scriptPath, "#!/bin/sh\necho SWAPPED\n");

    // 同一 capability key の 2 回目の execute は、承認キャッシュから即実行され
    // てはならない。integrity チェックが cache チェックより優先されるはずで、
    // 変化を検出して再度 pending に入り、integrityChanged が立つ。
    const execSocket = await connectUnix(execSocketPath);
    await writeJsonLine(execSocket, {
      type: "execute",
      request: {
        version: 2,
        type: "execute",
        sessionId: "sess_integ2",
        requestId: "req_cache_2",
        argv0: scriptPath,
        args: [],
        cwd: workspace,
        tty: false,
        stdinMode: "none",
      },
    });

    let hit: { requestId: string; integrityChanged?: boolean } | undefined;
    for (let i = 0; i < 50; i++) {
      const res = (await sendHostExecControlRequest(controlSocketPath, {
        type: "list_pending",
      })) as PendingListResponse;
      hit = res.items.find((it) => it.requestId === "req_cache_2");
      if (hit) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hit).toBeDefined();
    expect(hit?.integrityChanged).toBe(true);

    const responsePromise = readJsonLine(execSocket);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_cache_2",
    });
    await responsePromise;
    execSocket.destroy();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: allow rule denies when target changed and prompt is disabled", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-integ-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-audit-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const scriptPath = path.join(workspace, "tool.sh");
  await writeFile(scriptPath, "#!/bin/sh\necho original\n");
  await chmod(scriptPath, 0o755);

  const config: HostExecConfig = {
    prompt: {
      enable: false,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "off",
    },
    secrets: {},
    rules: [
      {
        id: "tool-allow",
        match: { argv0: scriptPath },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "deny",
      },
    ],
  };

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_integ3",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    auditDir,
    hostexec: config,
    integrityTargets: [scriptPath],
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_integ3");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_integ3");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // baseline snapshot 後にファイル内容を差し替える。
    await writeFile(scriptPath, "#!/bin/sh\necho SWAPPED\n");

    // approval: allow であっても、integrity mismatch かつ prompt.enable が
    // false のときは承認手段が無いので単発の error 応答で deny される
    // （pending にはならない）。
    const response = await sendTestGatewayRequest(
      execSocketPath,
      request([], workspace, "req_mismatch_deny", scriptPath),
    );
    expect(response.type).toEqual("error");
    if (response.type === "error") {
      expect(response.message).toMatch(/changed since session start/);
    }

    const logs = await queryAuditLogs({ domain: "hostexec" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("integrity-mismatch");
    expect(logs[0].requestId).toEqual("req_mismatch_deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: relative argv0 resolves integrity target via cwd at execute time", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-integ-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspaceRaw = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  // resolveRequest normalizes cwd via realpath before the integrity check
  // resolves the relative argv0 against it, so the integrityTargets entry
  // must be built from the same canonical (realpath'd) directory, not the
  // raw mkdtemp path, to avoid a spurious mismatch on platforms where tmpdir
  // itself is a symlink.
  const workspace = await realpath(workspaceRaw);
  const scriptPath = path.join(workspace, "tool.sh");
  await writeFile(scriptPath, "#!/bin/sh\necho original\n");
  await chmod(scriptPath, 0o755);

  const config: HostExecConfig = {
    prompt: {
      enable: true,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "off",
    },
    secrets: {},
    rules: [
      {
        id: "tool-relative",
        match: { argv0: "./tool.sh" },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "deny",
      },
    ],
  };

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_integ4",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: config,
    integrityTargets: [scriptPath],
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_integ4");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_integ4");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // baseline snapshot 後にファイル内容を差し替える。
    await writeFile(scriptPath, "#!/bin/sh\necho SWAPPED\n");

    // execute 時の argv0 は相対パス "./tool.sh"。integrityVerdict が
    // resolve(cwd, argv0) で baseline のキー（integrityTargets に渡した絶対
    // パス）に正しく到達することを確認する。allow ルールでも即実行されず
    // pending になり、integrityChanged が立つはず。
    const execSocket = await connectUnix(execSocketPath);
    await writeJsonLine(execSocket, {
      type: "execute",
      request: {
        version: 2,
        type: "execute",
        sessionId: "sess_integ4",
        requestId: "req_rel_1",
        argv0: "./tool.sh",
        args: [],
        cwd: workspace,
        tty: false,
        stdinMode: "none",
      },
    });

    let hit: { requestId: string; integrityChanged?: boolean } | undefined;
    for (let i = 0; i < 50; i++) {
      const res = (await sendHostExecControlRequest(controlSocketPath, {
        type: "list_pending",
      })) as PendingListResponse;
      hit = res.items.find((it) => it.requestId === "req_rel_1");
      if (hit) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hit).toBeDefined();
    expect(hit?.integrityChanged).toBe(true);

    const responsePromise = readJsonLine(execSocket);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_rel_1",
    });
    await responsePromise;
    execSocket.destroy();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRaw, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: symlinked workspace root does not break the integrity baseline lookup", async () => {
  // integrityTargets のキーは、呼び出し元（HostExecStage 相当）が
  // path.resolve(workDir, a) で組み立てる（realpath はしない）契約になって
  // いる。一方 broker は execute 時に normalizeAllowedCwd で cwd を realpath
  // 済みに正規化してから hostPath を組み立てる。workDir の途中に symlink が
  // 挟まっていると、この2つのキーは単純な比較では不一致になる。broker 側で両方を
  // canonicalizeIntegrityPath（realpath, フォールバック path.resolve）に通す
  // ことで、symlink があってもキーが一致し、内容が変わっていないファイルが
  // 誤って integrity-mismatch（prompt/deny）にならないことを確認する。
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-integ-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "nas-hostexec-symlink-")),
  );
  const realDir = path.join(base, "real");
  const symDir = path.join(base, "sym");
  await mkdir(realDir, { recursive: true });
  await symlink(realDir, symDir);

  // stage 相当のコードが行う「realpath せずに resolve するだけ」のキー生成を
  // symDir（symlink 経由のパス）を使って再現する。
  const scriptPath = path.resolve(symDir, "tool.sh");
  await writeFile(scriptPath, "#!/bin/sh\necho original\n");
  await chmod(scriptPath, 0o755);

  const config: HostExecConfig = {
    prompt: {
      enable: true,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "off",
    },
    secrets: {},
    rules: [
      {
        id: "tool-symlink",
        match: { argv0: "./tool.sh" },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "deny",
      },
    ],
  };

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_integ5",
    profileName: "test",
    notify: "off",
    workspaceRoot: symDir,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: config,
    integrityTargets: [scriptPath],
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_integ5");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_integ5");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // ファイル内容は baseline から一切変えていない。cwd に symlink 経由の
    // symDir を渡し、argv0 は相対パス "./tool.sh"。baseline キーと lookup
    // キーが symlink のせいで食い違えば、変化していないのに毎回 prompt
    // （このテストでは pending 発生）になってしまう。
    const result = await sendStreamingRequest(execSocketPath, {
      version: 2,
      type: "execute",
      sessionId: "sess_integ5",
      requestId: "req_symlink_1",
      argv0: "./tool.sh",
      args: [],
      cwd: symDir,
      tty: false,
      stdinMode: "none",
    });
    expect(result.exitCode).toEqual(0);
    expect(collectStdout(result).trim()).toEqual("original");

    // 承認待ちに一切入らず即実行されたことも明示的に確認する。
    const pending = (await sendHostExecControlRequest(controlSocketPath, {
      type: "list_pending",
    })) as PendingListResponse;
    expect(pending.items.find((it) => it.requestId === "req_symlink_1")).toBe(
      undefined,
    );
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: start() survives a snapshot error and falls back to prompt for that target", async () => {
  // start() の baseline snapshot ループが対象ファイルの EACCES で例外を投げると
  // ブローカー全体の起動が失敗する。broker はエラーを個別に捕捉し、そのファイル
  // だけ baseline に登録せずに起動を継続する。以降その target を execute する
  // 際は baseline 未登録 = decideIntegrity(undefined, …) が prompt に倒れる
  // fail-safe を確認する。
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-integ-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const scriptPath = path.join(runtimeDir, "tool.sh");
  await writeFile(scriptPath, "#!/bin/sh\necho original\n");
  // start() の snapshot 中は読み取り不可にしておき、EACCES で
  // readFileIntegrity が rethrow する状況を作る。
  await chmod(scriptPath, 0o000);

  const config: HostExecConfig = {
    prompt: {
      enable: true,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "off",
    },
    secrets: {},
    rules: [
      {
        id: "tool-eacces",
        match: { argv0: scriptPath },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "deny",
      },
    ],
  };

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_integ7",
    profileName: "test",
    notify: "off",
    workspaceRoot: runtimeDir,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: config,
    integrityTargets: [scriptPath],
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_integ7");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_integ7");
  try {
    // ここで throw すればテストが fail する。start() が例外を握り込んで
    // 起動を完了させることを確認する。
    await broker.start(execSocketPath, controlSocketPath);

    // 起動後にパーミッションを戻す。baseline には登録されていないので、以降の
    // execute では「変化なし」ではなく「未追跡ゆえの prompt」に倒れるはず。
    await chmod(scriptPath, 0o755);

    const execSocket = await connectUnix(execSocketPath);
    await writeJsonLine(execSocket, {
      type: "execute",
      request: {
        version: 2,
        type: "execute",
        sessionId: "sess_integ7",
        requestId: "req_eacces_1",
        argv0: scriptPath,
        args: [],
        cwd: runtimeDir,
        tty: false,
        stdinMode: "none",
      },
    });

    let hit: { requestId: string; integrityChanged?: boolean } | undefined;
    for (let i = 0; i < 50; i++) {
      const res = (await sendHostExecControlRequest(controlSocketPath, {
        type: "list_pending",
      })) as PendingListResponse;
      hit = res.items.find((it) => it.requestId === "req_eacces_1");
      if (hit) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hit).toBeDefined();
    expect(hit?.integrityChanged).toBe(true);

    const responsePromise = readJsonLine(execSocket);
    await sendHostExecControlRequest(controlSocketPath, {
      type: "deny",
      requestId: "req_eacces_1",
    });
    await responsePromise;
    execSocket.destroy();
  } finally {
    await chmod(scriptPath, 0o755).catch(() => {});
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: an integrity check error is audited and reported instead of crashing the connection", async () => {
  // readFileIntegrity は ENOENT 以外のエラー（EACCES, ENOTDIR 等）を rethrow
  // する。integrityVerdict がそれを伝播させると、他の deny 系分岐（policy-deny
  // / integrity-mismatch / prompt-disabled）と違って recordAudit が一度も呼ば
  // れないまま接続が失敗し、監査ログに証跡が残らない。executeStreaming が
  // integrityVerdict 呼び出しを try/catch し、"integrity-check-error" として
  // audit してから error 応答を返すことを確認する。
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-integ-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-audit-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);

  // integrity 機能自体を有効化するための placeholder target を用意する。実際の
  // 呼び出し対象とは別に、正常に snapshot できるファイルを指定する。
  const dummyTarget = path.join(runtimeDir, "dummy.sh");
  await writeFile(dummyTarget, "#!/bin/sh\necho dummy\n");

  // 通常ファイルの中に "子パス" を作ることで、stat が ENOTDIR で失敗する
  // ホストパスを用意する。ENOTDIR は ENOENT ではないので readFileIntegrity は
  // absent を返さず rethrow する。
  const regularFile = path.join(runtimeDir, "bad.sh");
  await writeFile(regularFile, "#!/bin/sh\necho unreachable\n");
  const brokenArgv0 = path.join(regularFile, "child");

  const config: HostExecConfig = {
    prompt: {
      enable: true,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "off",
    },
    secrets: {},
    rules: [
      {
        id: "tool-broken",
        match: { argv0: brokenArgv0 },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "deny",
      },
    ],
  };

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_integ6",
    profileName: "test",
    notify: "off",
    workspaceRoot: runtimeDir,
    sessionTmpDir: `${runtimeDir}/tmp`,
    auditDir,
    hostexec: config,
    integrityTargets: [dummyTarget],
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_integ6");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_integ6");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const response = await sendTestGatewayRequest(
      execSocketPath,
      request([], runtimeDir, "req_integrity_error", brokenArgv0),
    );
    expect(response.type).toEqual("error");
    if (response.type === "error") {
      expect(response.message).toMatch(/integrity/i);
    }

    const logs = await queryAuditLogs({ domain: "hostexec" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("integrity-check-error");
    expect(logs[0].requestId).toEqual("req_integrity_error");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});
