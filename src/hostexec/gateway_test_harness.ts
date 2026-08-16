import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createUnixServer,
  type Server,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import type { ExternalExecuteRequestV2 } from "./gateway_protocol.ts";
import { buildInterceptArtifactsForDev } from "./intercept_dev_build.ts";
import {
  resolveHostExecClientPath,
  resolveHostExecGatewayPath,
  resolveInterceptLibPath,
} from "./intercept_path.ts";

export interface GatewayTestArtifacts {
  readonly clientPath: string | null;
  readonly gatewayPath: string | null;
  readonly interceptLibPath: string | null;
}

let gatewayTestArtifactsPromise: Promise<GatewayTestArtifacts> | undefined;

export function resolveGatewayTestArtifacts(): Promise<GatewayTestArtifacts> {
  gatewayTestArtifactsPromise ??= (async () => {
    // A single `zig build` produces this whole transport boundary. Resolve all
    // three outputs together so a native integration test cannot accidentally
    // combine a current client with a stale gateway or interceptor artifact.
    await buildInterceptArtifactsForDev();
    const [clientPath, gatewayPath, interceptLibPath] = await Promise.all([
      resolveHostExecClientPath(),
      resolveHostExecGatewayPath(),
      resolveInterceptLibPath(),
    ]);
    return { clientPath, gatewayPath, interceptLibPath };
  })();
  return gatewayTestArtifactsPromise;
}

export interface GatewayStartSpec {
  readonly argv0: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type GatewayDecision =
  | { readonly type: "start"; readonly spec: GatewayStartSpec }
  | { readonly type: "fallback" }
  | { readonly type: "error"; readonly message: string };

export interface GatewayTestHarnessOptions {
  readonly artifacts: GatewayTestArtifacts;
  readonly sessionId?: string;
  /** Directory visible to Docker when an integration test uses DinD. */
  readonly tempDir?: string;
  readonly decide?: (
    request: ExternalExecuteRequestV2,
  ) => GatewayDecision | Promise<GatewayDecision>;
}

export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type GatewayTestEvent =
  | {
      readonly type: "spawned";
      readonly requestId: string;
      readonly pid: number;
    }
  | {
      readonly type: "process_exit";
      readonly requestId: string;
      readonly exitCode: number;
    }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly exitCode: number;
    };

export interface GatewayTestHarness {
  readonly artifacts: GatewayTestArtifacts;
  readonly rootDir: string;
  readonly wrapperDir: string;
  readonly realDir: string;
  readonly interceptedNoReadPath: string;
  /** The only host directory a container-side client may mount. */
  readonly externalSocketDir: string;
  readonly externalSocketPath: string;
  readonly internalSocketPath: string;
  readonly requests: ExternalExecuteRequestV2[];
  /** Lifecycle frames observed on the host-only broker connection. */
  readonly events: GatewayTestEvent[];
  runBareShell(script: string): Promise<ShellResult>;
  runInterceptedShell(script: string): Promise<ShellResult>;
  runShell(
    script: string,
    options?: {
      readonly interceptedPath?: string;
      readonly pathEnv?: string;
      /** Override the external socket env; null omits it. */
      readonly socketPath?: string | null;
      /** Override the session env; null omits it. */
      readonly sessionId?: string | null;
    },
  ): Promise<ShellResult>;
  /** Disconnect every host-only broker handler without stopping the gateway. */
  disconnectBroker(): Promise<void>;
  close(): Promise<void>;
}

interface LineReader {
  read(): Promise<string | null>;
}

function makeLineReader(socket: Socket): LineReader {
  const iterator = socket[Symbol.asyncIterator]();
  let buffered = "";
  let ended = false;

  return {
    async read(): Promise<string | null> {
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return line;
        }
        if (ended) return buffered.length > 0 ? buffered : null;
        const next = await iterator.next();
        if (next.done) {
          ended = true;
          continue;
        }
        buffered += next.value.toString();
      }
    },
  };
}

async function handleBrokerConnection(
  socket: Socket,
  requests: ExternalExecuteRequestV2[],
  events: GatewayTestEvent[],
  decide: (
    request: ExternalExecuteRequestV2,
  ) => GatewayDecision | Promise<GatewayDecision>,
): Promise<void> {
  const reader = makeLineReader(socket);
  try {
    const firstLine = await reader.read();
    if (!firstLine) return;
    const first = JSON.parse(firstLine) as {
      type?: string;
      request?: ExternalExecuteRequestV2;
    };
    if (first.type !== "execute" || !first.request) {
      throw new Error("mock gateway broker expected execute");
    }
    const request = first.request;
    requests.push(request);
    const decision = await decide(request);
    if (decision.type === "fallback") {
      await writeJsonLine(socket, {
        type: "fallback",
        requestId: request.requestId,
      });
      return;
    }
    if (decision.type === "error") {
      await writeJsonLine(socket, {
        type: "error",
        requestId: request.requestId,
        message: decision.message,
      });
      return;
    }

    await writeJsonLine(socket, {
      type: "start",
      requestId: request.requestId,
      argv0: decision.spec.argv0,
      args: [...decision.spec.args],
      cwd: decision.spec.cwd,
      env: { ...decision.spec.env },
    });

    let spawned = false;
    let finished = false;
    while (true) {
      const line = await reader.read();
      if (!line) return;
      const message = JSON.parse(line) as {
        type?: string;
        requestId?: string;
        fd?: 1 | 2;
        data?: string;
        exitCode?: number;
        pid?: number;
      };
      if (message.requestId !== request.requestId) {
        throw new Error("mock gateway broker request ID mismatch");
      }
      if (message.type === "spawned") {
        const pid = message.pid;
        if (
          spawned ||
          finished ||
          typeof pid !== "number" ||
          !Number.isSafeInteger(pid) ||
          pid <= 0
        ) {
          throw new Error("mock gateway broker received invalid spawned");
        }
        spawned = true;
        events.push({
          type: "spawned",
          requestId: request.requestId,
          pid,
        });
        continue;
      }
      if (message.type === "raw_chunk") {
        if (!spawned || finished) {
          throw new Error(
            "mock gateway broker received raw_chunk out of order",
          );
        }
        await writeJsonLine(socket, {
          type: "masked_chunk",
          requestId: request.requestId,
          fd: message.fd,
          data: message.data,
        });
        continue;
      }
      if (message.type === "process_exit") {
        const exitCode = message.exitCode;
        if (
          !spawned ||
          finished ||
          typeof exitCode !== "number" ||
          !Number.isSafeInteger(exitCode)
        ) {
          throw new Error("mock gateway broker received invalid process_exit");
        }
        finished = true;
        events.push({
          type: "process_exit",
          requestId: request.requestId,
          exitCode,
        });
        await writeJsonLine(socket, {
          type: "result",
          requestId: request.requestId,
          exitCode,
        });
        events.push({
          type: "result",
          requestId: request.requestId,
          exitCode,
        });
        return;
      }
      if (message.type === "cancelled" || message.type === "transport_error") {
        return;
      }
      throw new Error(
        `mock gateway broker received ${message.type ?? "unknown"}`,
      );
    }
  } catch (error) {
    socket.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

async function readReadyLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const reader = stream.getReader();
  let bytes = "";
  const read = (async () => {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error("gateway exited before readiness");
      bytes += new TextDecoder().decode(next.value);
      const newline = bytes.indexOf("\n");
      if (newline >= 0) {
        void (async () => {
          try {
            while (!(await reader.read()).done) {
              // Keep the gateway stdout pipe drained after the readiness line.
            }
          } catch {
            // Gateway shutdown closes this diagnostic-only stream.
          }
        })();
        return JSON.parse(bytes.slice(0, newline)) as Record<string, unknown>;
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<Record<string, unknown>>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("gateway readiness timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeFallbackBinary(realDir: string): Promise<void> {
  const target = path.join(realDir, "intercepted-no-read");
  await writeFile(target, "#!/bin/sh\nprintf fallback-ran\nexit 77\n");
  await chmod(target, 0o755);
}

export async function startGatewayTestHarness(
  options: GatewayTestHarnessOptions,
): Promise<GatewayTestHarness> {
  const { artifacts } = options;
  if (!artifacts.gatewayPath) {
    throw new Error(
      "hostexec gateway artifact is unavailable (cd src/hostexec/intercept && zig build)",
    );
  }
  const sessionId = options.sessionId ?? "test-session";
  const rootDir = await mkdtemp(
    path.join(options.tempDir ?? tmpdir(), "nas-hostexec-gateway-"),
  );
  const wrapperDir = path.join(rootDir, "wrapper");
  const realDir = path.join(rootDir, "real");
  const interceptedNoReadPath = path.join(rootDir, "intercepted-no-read");
  // Keep the external endpoint in its own directory. Docker integration tests
  // mount this exact directory, which makes an accidental host-only socket
  // sibling visible rather than silently testing a broader mount.
  const externalSocketDir = path.join(rootDir, "external");
  const externalSocketPath = path.join(externalSocketDir, "external.sock");
  const internalSocketPath = path.join(rootDir, "internal", "gateway.sock");
  const requests: ExternalExecuteRequestV2[] = [];
  const events: GatewayTestEvent[] = [];
  let brokerServer: Server | null = null;
  let gatewayProcess: ReturnType<typeof Bun.spawn> | null = null;
  const activeBrokerSockets = new Set<Socket>();
  const decide =
    options.decide ??
    (() => ({
      type: "start" as const,
      spec: {
        argv0: Bun.which("true") ?? "/usr/bin/true",
        args: [],
        cwd: "/",
        env: { PATH: process.env.PATH ?? "" },
      },
    }));

  try {
    await mkdir(wrapperDir, { recursive: true });
    await mkdir(realDir, { recursive: true });
    await mkdir(externalSocketDir, { recursive: true });
    await mkdir(path.dirname(internalSocketPath), { recursive: true });
    if (artifacts.clientPath) {
      await symlink(
        artifacts.clientPath,
        path.join(wrapperDir, "intercepted-no-read"),
      );
    }
    await writeFallbackBinary(realDir);
    await writeFile(interceptedNoReadPath, "#!/bin/sh\nexit 99\n");
    await chmod(interceptedNoReadPath, 0o755);

    brokerServer = await createUnixServer(internalSocketPath, (socket) => {
      activeBrokerSockets.add(socket);
      socket.once("close", () => activeBrokerSockets.delete(socket));
      void handleBrokerConnection(socket, requests, events, decide);
    });
    gatewayProcess = Bun.spawn(
      [
        artifacts.gatewayPath,
        "--session-id",
        sessionId,
        "--external-socket",
        externalSocketPath,
        "--internal-socket",
        internalSocketPath,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
    );
    const ready = await readReadyLine(
      gatewayProcess.stdout as ReadableStream<Uint8Array>,
    );
    if (
      ready.type !== "ready" ||
      ready.version !== 2 ||
      ready.socket !== externalSocketPath
    ) {
      throw new Error(`invalid gateway readiness: ${JSON.stringify(ready)}`);
    }

    const runShell = async (
      script: string,
      shellOptions: {
        readonly interceptedPath?: string;
        readonly pathEnv?: string;
        readonly socketPath?: string | null;
        readonly sessionId?: string | null;
      } = {},
    ): Promise<ShellResult> => {
      const bashPath = Bun.which("bash");
      if (!bashPath) throw new Error("bash is required for gateway tests");
      const preload = shellOptions.interceptedPath
        ? artifacts.interceptLibPath
        : undefined;
      if (shellOptions.interceptedPath && !preload) {
        throw new Error("hostexec intercept library is unavailable");
      }
      const childEnv = { ...process.env };
      delete childEnv.LD_PRELOAD;
      delete childEnv.NAS_HOSTEXEC_INTERCEPT_PATHS;
      delete childEnv.NAS_HOSTEXEC_SESSION_ID;
      delete childEnv.NAS_HOSTEXEC_SOCKET;
      delete childEnv.NAS_HOSTEXEC_WRAPPER_DIR;
      const proc = Bun.spawn([bashPath, "-c", script], {
        cwd: rootDir,
        env: {
          ...childEnv,
          PATH:
            shellOptions.pathEnv ??
            `${wrapperDir}:${realDir}:${process.env.PATH ?? ""}`,
          NAS_HOSTEXEC_WRAPPER_DIR: wrapperDir,
          ...(shellOptions.socketPath === null
            ? {}
            : {
                NAS_HOSTEXEC_SOCKET:
                  shellOptions.socketPath ?? externalSocketPath,
              }),
          ...(shellOptions.sessionId === null
            ? {}
            : {
                NAS_HOSTEXEC_SESSION_ID: shellOptions.sessionId ?? sessionId,
              }),
          ...(preload
            ? {
                LD_PRELOAD: preload,
                NAS_HOSTEXEC_INTERCEPT_PATHS: shellOptions.interceptedPath,
              }
            : {}),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    const runBareShell = (script: string): Promise<ShellResult> => {
      if (!artifacts.clientPath) {
        return Promise.reject(
          new Error(
            "hostexec standalone client artifact is unavailable for bare-run tests",
          ),
        );
      }
      return runShell(script);
    };

    return {
      artifacts,
      rootDir,
      wrapperDir,
      realDir,
      interceptedNoReadPath,
      externalSocketDir,
      externalSocketPath,
      internalSocketPath,
      requests,
      events,
      runBareShell,
      runInterceptedShell: (script) =>
        runShell(script, { interceptedPath: interceptedNoReadPath }),
      runShell,
      disconnectBroker: async () => {
        const sockets = [...activeBrokerSockets];
        const closed = sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.destroyed) {
                resolve();
                return;
              }
              socket.once("close", () => resolve());
              socket.destroy();
            }),
        );
        await Promise.all(closed);
      },
      close: async () => {
        for (const socket of activeBrokerSockets) socket.destroy();
        brokerServer?.close();
        brokerServer = null;
        if (gatewayProcess) {
          try {
            gatewayProcess.kill("SIGTERM");
          } catch {
            // It may already have exited after a test failure.
          }
          await gatewayProcess.exited.catch(() => 1);
          gatewayProcess = null;
        }
        await rm(rootDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const socket of activeBrokerSockets) socket.destroy();
    brokerServer?.close();
    if (gatewayProcess) {
      try {
        gatewayProcess.kill("SIGKILL");
      } catch {
        // Process may already be gone.
      }
      await gatewayProcess.exited.catch(() => 1);
    }
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}
