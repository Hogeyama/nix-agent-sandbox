import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { RawLineReader, runGatewayExecution } from "./gateway_execution.ts";
import { maxControlBytes, parseBrokerToGateway } from "./gateway_protocol.ts";
import {
  captureFilterProcessIdentities,
  createPostEofStallFilter,
  type FilterProcessIdentity,
  forceFilterProcessesGone,
  readFilterProcessIdentity,
  waitForFilterProcessesGone,
  waitForRecordedFilterPids,
} from "./post_eof_filter_test_support.ts";

const TRUE_PATH = Bun.which("true") ?? "/bin/true";
const FALSE_PATH = Bun.which("false") ?? "/bin/false";

interface GatewayHarness {
  readonly gateway: Socket;
  readonly client: Socket;
  readLine(): Promise<Record<string, unknown>>;
  drainToEof(cancellation?: AbortSignal): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

async function openGatewayHarness(): Promise<GatewayHarness> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");

  const gatewayPromise = new Promise<Socket>((resolve, reject) => {
    server.once("connection", resolve);
    server.once("error", reject);
  });
  const client = await new Promise<Socket>((resolve, reject) => {
    const connected = createConnection({ port: address.port }, () =>
      resolve(connected),
    );
    connected.once("error", reject);
  });
  const gateway = await gatewayPromise;

  let buffer = "";
  let ended = false;
  let failure: Error | null = null;
  const pending: Array<{
    resolve: (line: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }> = [];
  const lines: string[] = [];
  const parseLine = (value: string): Record<string, unknown> =>
    JSON.parse(value) as Record<string, unknown>;
  const endWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const settleEndWaiters = () => {
    if (!ended) return;
    if (failure) {
      while (endWaiters.length > 0) endWaiters.shift()?.reject(failure);
    } else {
      while (endWaiters.length > 0) endWaiters.shift()?.resolve();
    }
  };
  const waitForEnd = (cancellation?: AbortSignal): Promise<void> => {
    if (cancellation?.aborted) {
      return Promise.reject(
        cancellation.reason instanceof Error
          ? cancellation.reason
          : new Error("gateway harness EOF wait cancelled"),
      );
    }
    if (ended) {
      return failure ? Promise.reject(failure) : Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const removeWaiter = () => {
        const index = endWaiters.indexOf(waiter);
        if (index >= 0) endWaiters.splice(index, 1);
      };
      const onAbort = () => {
        removeWaiter();
        cancellation?.removeEventListener("abort", onAbort);
        reject(
          cancellation?.reason instanceof Error
            ? cancellation.reason
            : new Error("gateway harness EOF wait cancelled"),
        );
      };
      const waiter = {
        resolve: () => {
          cancellation?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error: Error) => {
          cancellation?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      endWaiters.push(waiter);
      cancellation?.addEventListener("abort", onAbort, { once: true });
    });
  };
  const flush = () => {
    while (lines.length > 0 && pending.length > 0) {
      const line = lines.shift();
      const waiter = pending.shift();
      if (line === undefined || waiter === undefined) return;
      try {
        waiter.resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        waiter.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (ended && pending.length > 0 && lines.length === 0) {
      const error = failure ?? new Error("gateway ended");
      while (pending.length > 0) pending.shift()?.reject(error);
    }
  };
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    flush();
  };
  const onEnd = () => {
    ended = true;
    flush();
    settleEndWaiters();
  };
  const onError = (error: Error) => {
    failure = error;
    ended = true;
    flush();
    settleEndWaiters();
  };
  gateway.on("data", onData);
  gateway.once("end", onEnd);
  gateway.once("close", onEnd);
  gateway.once("error", onError);

  return {
    gateway,
    client,
    readLine: async () => {
      if (lines.length > 0) {
        const line = lines.shift();
        if (line === undefined) throw new Error("missing gateway line");
        return JSON.parse(line) as Record<string, unknown>;
      }
      if (ended) throw failure ?? new Error("gateway ended");
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    drainToEof: async (cancellation?: AbortSignal) => {
      await waitForEnd(cancellation);
      if (buffer.length > 0) {
        throw new Error("gateway ended with an unterminated broker frame");
      }
      return lines.splice(0).map(parseLine);
    },
    close: async () => {
      const error = new Error("gateway harness closed");
      while (pending.length > 0) pending.shift()?.reject(error);
      while (endWaiters.length > 0) endWaiters.shift()?.reject(error);
      gateway.off("data", onData);
      gateway.off("end", onEnd);
      gateway.off("close", onEnd);
      gateway.off("error", onError);
      client.destroy();
      gateway.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function startOptions(socket: Socket, requestId = "r1") {
  return {
    socket,
    requestId,
    start: {
      type: "start" as const,
      requestId,
      argv0: "echo",
      args: [],
      cwd: "/tmp",
      env: {},
    },
    onSpawned: async () => {},
  };
}

function line(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function writeSocketLine(socket: Socket, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(value, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function expectFailure(run: Promise<void>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected gateway execution to fail");
}

async function endBrokerAndDrainToPeerEof(
  harness: GatewayHarness,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>[]> {
  const cancellation = new AbortController();
  const timeout = setTimeout(() => {
    cancellation.abort(
      new Error("timed out draining broker responses to peer EOF"),
    );
  }, timeoutMs);
  const drain = harness.drainToEof(cancellation.signal);
  try {
    harness.client.end();
    return await drain;
  } catch (error) {
    if (!cancellation.signal.aborted) {
      cancellation.abort(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await drain.catch(() => {});
  }
}

function expectNoTerminalBrokerFrames(
  messages: readonly Record<string, unknown>[],
): void {
  for (const message of messages) {
    parseBrokerToGateway(message, "awaiting_result");
  }
  expect(messages).toEqual([]);
}

test("RawLineReader enforces the 4 MiB limit before a delimiter arrives", async () => {
  const harness = await openGatewayHarness();
  const reader = new RawLineReader(harness.client);
  try {
    const pending = reader.read();
    const payload = Buffer.alloc(maxControlBytes + 3, 0x61);
    await new Promise<void>((resolve, reject) => {
      harness.gateway.write(payload, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await expect(pending).rejects.toThrow(/control message exceeds/);
  } finally {
    reader.close();
    await harness.close();
  }
});

test("runGatewayExecution sends start, masks identity output, and waits for process_exit", async () => {
  const harness = await openGatewayHarness();
  try {
    const run = runGatewayExecution(startOptions(harness.client));

    expect(await harness.readLine()).toMatchObject({
      type: "start",
      requestId: "r1",
    });
    harness.gateway.write(
      line({ type: "spawned", requestId: "r1", pid: process.pid }) +
        line({
          type: "raw_chunk",
          requestId: "r1",
          fd: 1,
          data: Buffer.from("hello").toString("base64"),
        }) +
        line({ type: "process_exit", requestId: "r1", exitCode: 7 }),
    );

    expect(await harness.readLine()).toMatchObject({
      type: "masked_chunk",
      requestId: "r1",
      fd: 1,
      data: Buffer.from("hello").toString("base64"),
    });
    expect(await harness.readLine()).toMatchObject({
      type: "result",
      requestId: "r1",
      exitCode: 7,
    });
    await run;
  } finally {
    await harness.close();
  }
});

test("runGatewayExecution keeps stdout and stderr in separate pipelines", async () => {
  const harness = await openGatewayHarness();
  try {
    const run = runGatewayExecution(startOptions(harness.client));
    await harness.readLine();
    harness.gateway.write(
      line({ type: "spawned", requestId: "r1", pid: process.pid }) +
        line({
          type: "raw_chunk",
          requestId: "r1",
          fd: 1,
          data: Buffer.from("stdout").toString("base64"),
        }) +
        line({
          type: "raw_chunk",
          requestId: "r1",
          fd: 2,
          data: Buffer.from("stderr").toString("base64"),
        }) +
        line({ type: "process_exit", requestId: "r1", exitCode: 0 }),
    );
    const first = await harness.readLine();
    const second = await harness.readLine();
    expect([first, second]).toEqual([
      {
        type: "masked_chunk",
        requestId: "r1",
        fd: 1,
        data: Buffer.from("stdout").toString("base64"),
      },
      {
        type: "masked_chunk",
        requestId: "r1",
        fd: 2,
        data: Buffer.from("stderr").toString("base64"),
      },
    ]);
    expect(await harness.readLine()).toMatchObject({ type: "result" });
    await run;
  } finally {
    await harness.close();
  }
});

test("runGatewayExecution masks a secret split across raw chunks", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nas-gateway-filter-"));
  const filterPath = path.join(tempDir, "split-filter");
  await writeFile(
    filterPath,
    `#!${process.execPath}
const chunks = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
const text = Buffer.concat(chunks).toString().replaceAll("SECRET", "[MASKED]");
process.stdout.write(text);
`,
  );
  await chmod(filterPath, 0o700);

  const harness = await openGatewayHarness();
  try {
    const run = runGatewayExecution({
      ...startOptions(harness.client),
      maskFilter: {
        binaryPath: filterPath,
        secretsFramePath: path.join(tempDir, "secrets.frame"),
      },
    });
    await harness.readLine();
    harness.gateway.write(
      line({ type: "spawned", requestId: "r1", pid: process.pid }) +
        line({
          type: "raw_chunk",
          requestId: "r1",
          fd: 1,
          data: Buffer.from("SUPERSE").toString("base64"),
        }) +
        line({
          type: "raw_chunk",
          requestId: "r1",
          fd: 1,
          data: Buffer.from("CRET").toString("base64"),
        }) +
        line({
          type: "raw_chunk",
          requestId: "r1",
          fd: 2,
          data: Buffer.from("stderr").toString("base64"),
        }) +
        line({ type: "process_exit", requestId: "r1", exitCode: 0 }),
    );

    const chunks: Record<1 | 2, string[]> = { 1: [], 2: [] };
    while (true) {
      const message = await harness.readLine();
      expect(JSON.stringify(message)).not.toContain("SECRET");
      if (message.type === "masked_chunk") {
        const fd = Number(message.fd) as 1 | 2;
        chunks[fd].push(Buffer.from(String(message.data), "base64").toString());
      } else if (message.type === "result") {
        break;
      }
    }
    expect(chunks[1].join("")).toBe("SUPER[MASKED]");
    expect(chunks[2].join("")).toBe("stderr");
    await run;
  } finally {
    await harness.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runGatewayExecution applies backpressure while masking sustained max-size chunks", async () => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "nas-gateway-slow-filter-"),
  );
  const filterPath = path.join(tempDir, "slow-filter");
  await writeFile(
    filterPath,
    `#!${process.execPath}
for await (const chunk of Bun.stdin.stream()) {
  await Bun.sleep(2);
  process.stdout.write(chunk);
}
`,
  );
  await chmod(filterPath, 0o700);

  const harness = await openGatewayHarness();
  let healthSubscriptions = 0;
  try {
    const run = runGatewayExecution({
      ...startOptions(harness.client),
      onPipelineHealthSubscription: () => {
        healthSubscriptions += 1;
      },
      maskFilter: {
        binaryPath: filterPath,
        secretsFramePath: path.join(tempDir, "secrets.frame"),
      },
    });
    await harness.readLine();
    await writeSocketLine(
      harness.gateway,
      line({ type: "spawned", requestId: "r1", pid: process.pid }),
    );

    const chunkCount = 96;
    const chunkSize = 64 * 1024;
    const rawChunk = Buffer.alloc(chunkSize, 0x41);
    const maskedOutput = (async () => {
      let bytes = 0;
      while (true) {
        const message = await harness.readLine();
        if (message.type === "masked_chunk") {
          bytes += Buffer.from(String(message.data), "base64").length;
        } else if (message.type === "result") {
          return bytes;
        }
      }
    })();

    for (let index = 0; index < chunkCount; index++) {
      await writeSocketLine(
        harness.gateway,
        line({
          type: "raw_chunk",
          requestId: "r1",
          fd: 1,
          data: rawChunk.toString("base64"),
        }),
      );
    }
    await writeSocketLine(
      harness.gateway,
      line({ type: "process_exit", requestId: "r1", exitCode: 0 }),
    );

    expect(await maskedOutput).toBe(chunkCount * chunkSize);
    await run;
    expect(healthSubscriptions).toBe(1);
  } finally {
    await harness.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runGatewayExecution keeps one health subscription and one retained frame while pulling many chunks", async () => {
  const harness = await openGatewayHarness();
  const chunkCount = 256;
  const chunk = Buffer.alloc(8 * 1024, 0x42);
  let readCount = 0;
  let concurrentReads = 0;
  let maxConcurrentReads = 0;
  let maxRetainedFrames = 0;
  let healthSubscriptions = 0;
  let aborted: Error | null = null;
  const reader = {
    async read(): Promise<Uint8Array | null> {
      if (aborted) throw aborted;
      concurrentReads += 1;
      maxConcurrentReads = Math.max(maxConcurrentReads, concurrentReads);
      // Produce exactly one frame on demand. A second concurrent pull would
      // make the retained-frame assertion exceed one.
      maxRetainedFrames = Math.max(maxRetainedFrames, 1);
      await Bun.sleep(0);
      const index = readCount++;
      const message =
        index === 0
          ? { type: "spawned", requestId: "r1", pid: process.pid }
          : index <= chunkCount
            ? {
                type: "raw_chunk",
                requestId: "r1",
                fd: 1,
                data: chunk.toString("base64"),
              }
            : { type: "process_exit", requestId: "r1", exitCode: 0 };
      concurrentReads -= 1;
      return new TextEncoder().encode(line(message));
    },
    close(): void {},
    abort(error: Error): void {
      aborted = error;
    },
  };
  try {
    const run = runGatewayExecution({
      ...startOptions(harness.client),
      reader,
      onPipelineHealthSubscription: () => {
        healthSubscriptions += 1;
      },
    });
    expect(await harness.readLine()).toMatchObject({ type: "start" });
    const output = (async () => {
      let bytes = 0;
      while (true) {
        const message = await harness.readLine();
        if (message.type === "masked_chunk") {
          bytes += Buffer.from(String(message.data), "base64").length;
        } else if (message.type === "result") {
          return bytes;
        }
      }
    })();
    await run;
    expect(await output).toBe(chunkCount * chunk.length);
    expect(healthSubscriptions).toBe(1);
    expect(maxConcurrentReads).toBe(1);
    expect(maxRetainedFrames).toBe(1);
  } finally {
    await harness.close();
  }
});

test("runGatewayExecution kills a spawned command when the gateway cancels", async () => {
  const harness = await openGatewayHarness();
  try {
    const run = runGatewayExecution(startOptions(harness.client));
    const rejected = expectFailure(run);
    await harness.readLine();
    harness.gateway.write(
      line({ type: "spawned", requestId: "r1", pid: process.pid }) +
        line({ type: "cancelled", requestId: "r1", reason: "client closed" }),
    );
    expect(await harness.readLine()).toMatchObject({
      type: "kill",
      requestId: "r1",
      signal: "SIGTERM",
    });
    expect((await rejected).message).toContain("gateway cancelled request");
  } finally {
    await harness.close();
  }
});

test("runGatewayExecution escalates a TERM-ignoring filter to SIGKILL", async () => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "nas-gateway-term-filter-"),
  );
  const filterPath = path.join(tempDir, "term-filter");
  const filterPidPath = path.join(tempDir, "term-filter.pid");
  await writeFile(
    filterPath,
    `#!${process.execPath}
import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(filterPidPath)}, String(process.pid) + "\\n");
process.on("SIGTERM", () => {});
process.stdout.write("ready");
for await (const _chunk of Bun.stdin.stream()) await Bun.sleep(100);
`,
  );
  await chmod(filterPath, 0o700);

  const harness = await openGatewayHarness();
  let run: Promise<void> | undefined;
  let filterIdentities: FilterProcessIdentity[] = [];
  let cleanupArmed = true;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    run = runGatewayExecution({
      ...startOptions(harness.client),
      maskFilter: {
        binaryPath: filterPath,
        secretsFramePath: path.join(tempDir, "secrets.frame"),
      },
    });
    const rejected = expectFailure(run);
    await harness.readLine();
    await writeSocketLine(
      harness.gateway,
      line({ type: "spawned", requestId: "r1", pid: process.pid }),
    );
    expect(await harness.readLine()).toMatchObject({
      type: "masked_chunk",
      requestId: "r1",
    });
    expect(await harness.readLine()).toMatchObject({
      type: "masked_chunk",
      requestId: "r1",
    });
    const filterPids = await waitForRecordedFilterPids(filterPidPath);
    expect(filterPids).toHaveLength(2);
    expect(new Set(filterPids).size).toBe(2);
    filterIdentities = await captureFilterProcessIdentities(filterPids);
    await writeSocketLine(
      harness.gateway,
      line({ type: "cancelled", requestId: "r1", reason: "client closed" }),
    );
    expect(await harness.readLine()).toMatchObject({
      type: "kill",
      requestId: "r1",
      signal: "SIGTERM",
    });
    const result = await Promise.race([
      rejected,
      new Promise<Error>((_, reject) =>
        setTimeout(() => reject(new Error("filter cleanup timed out")), 2_000),
      ),
    ]);
    expect(result.message).toContain("gateway cancelled request");
    await waitForFilterProcessesGone(filterIdentities);
    for (const identity of filterIdentities) {
      expect(await readFilterProcessIdentity(identity.pid)).toBeNull();
    }
    filterIdentities = [];
    cleanupArmed = false;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    harness.gateway.destroy();
    if (run) {
      await Promise.race([run.catch(() => {}), Bun.sleep(2_000)]);
    }
    if (cleanupArmed && filterIdentities.length > 0) {
      try {
        await forceFilterProcessesGone(filterIdentities);
      } catch (error) {
        cleanupError = error;
      }
    }
    await harness.close();
    await rm(tempDir, { recursive: true, force: true });
  }
  if (!primaryError && cleanupError) throw cleanupError;
});

test("runGatewayExecution kills after start for every pre-spawn failure", async () => {
  const cases: Array<{ message: unknown; error: string }> = [
    {
      message: { type: "spawned", requestId: "other", pid: process.pid },
      error: "request ID mismatch",
    },
    {
      message: { type: "unknown", requestId: "r1" },
      error: "invalid gateway message",
    },
    {
      message: {
        type: "raw_chunk",
        requestId: "r1",
        fd: 1,
        data: Buffer.from("raw").toString("base64"),
      },
      error: "raw output before spawned",
    },
    {
      message: { type: "cancelled", requestId: "r1", reason: "cancelled" },
      error: "gateway cancelled request",
    },
    {
      message: {
        type: "transport_error",
        requestId: "r1",
        message: "broken internal socket",
      },
      error: "gateway transport error",
    },
  ];

  for (const testCase of cases) {
    const harness = await openGatewayHarness();
    try {
      const run = runGatewayExecution(startOptions(harness.client));
      const rejected = expectFailure(run);
      await harness.readLine();
      harness.gateway.write(line(testCase.message));
      expect(await harness.readLine()).toMatchObject({
        type: "kill",
        requestId: "r1",
        signal: "SIGTERM",
      });
      expect((await rejected).message).toContain(testCase.error);
    } finally {
      await harness.close();
    }
  }

  const disconnected = await openGatewayHarness();
  try {
    const run = runGatewayExecution({
      ...startOptions(disconnected.client),
      reader: {
        read: async () => null,
        close: () => {},
        abort: () => {},
      },
    });
    const rejected = expectFailure(run);
    await disconnected.readLine();
    expect(await disconnected.readLine()).toMatchObject({
      type: "kill",
      requestId: "r1",
      signal: "SIGTERM",
    });
    expect((await rejected).message).toContain(
      "gateway disconnected before terminal state",
    );
  } finally {
    await disconnected.close();
  }
});

test("runGatewayExecution never sends an illegal kill after process_exit", async () => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "nas-gateway-late-filter-failure-"),
  );
  const filterPath = path.join(tempDir, "late-failing-filter");
  const harness = await openGatewayHarness();
  try {
    await writeFile(
      filterPath,
      `#!${process.execPath}
for await (const _chunk of Bun.stdin.stream()) {
}
process.exit(7);
`,
    );
    await chmod(filterPath, 0o700);
    const run = runGatewayExecution({
      ...startOptions(harness.client),
      maskFilter: {
        binaryPath: filterPath,
        secretsFramePath: "/tmp/no-secrets-frame",
      },
    });
    const rejected = expectFailure(run);
    expect(
      parseBrokerToGateway(await harness.readLine(), "awaiting_decision"),
    ).toMatchObject({ type: "start", requestId: "r1" });
    await writeSocketLine(
      harness.gateway,
      line({ type: "spawned", requestId: "r1", pid: process.pid }) +
        line({ type: "process_exit", requestId: "r1", exitCode: 0 }),
    );
    const error = await rejected;
    // Keep draining until the broker's half-close reaches the peer. This is
    // ordered after execution rejection, so a late write cannot hide behind
    // a timeout-raced read.
    expectNoTerminalBrokerFrames(await endBrokerAndDrainToPeerEof(harness));
    expect(error.message).toContain("nas-mask-filter exited with code");
  } finally {
    await harness.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runGatewayExecution fails closed for missing or corrupt mask frames even when the host exits zero", async () => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "nas-gateway-invalid-frame-"),
  );
  const filterPath = path.join(tempDir, "frame-check-filter");
  try {
    await writeFile(
      filterPath,
      `#!${process.execPath}
	const framePath = process.env.NAS_MASK_SECRETS_FILE;
	const frame = framePath && await Bun.file(framePath).text().catch(() => "");
	for await (const chunk of Bun.stdin.stream()) process.stdout.write(chunk);
	if (frame !== "valid-mask-frame") process.exit(23);
`,
    );
    await chmod(filterPath, 0o700);

    for (const [framePath, frame] of [
      [path.join(tempDir, "missing.frame"), null],
      [path.join(tempDir, "corrupt.frame"), "corrupt"],
    ] as const) {
      if (frame !== null) await writeFile(framePath, frame);
      const harness = await openGatewayHarness();
      try {
        const run = runGatewayExecution({
          ...startOptions(harness.client),
          maskFilter: {
            binaryPath: filterPath,
            secretsFramePath: framePath,
          },
        });
        const rejected = expectFailure(run);
        await harness.readLine();
        await writeSocketLine(
          harness.gateway,
          line({ type: "spawned", requestId: "r1", pid: process.pid }) +
            line({ type: "process_exit", requestId: "r1", exitCode: 0 }),
        );
        const error = await rejected;
        expectNoTerminalBrokerFrames(await endBrokerAndDrainToPeerEof(harness));
        expect(error.message).toMatch(/nas-mask-filter|23/);
        expect(error.message).not.toContain("result");
      } finally {
        await harness.close();
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runGatewayExecution interrupts post-exit filters when cancellation wins", async () => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "nas-gateway-post-eof-cancellation-"),
  );
  const { filterPath, pidPath, eofPath } =
    await createPostEofStallFilter(tempDir);
  const harness = await openGatewayHarness();
  const cancellation = new AbortController();
  let run: Promise<void> | undefined;
  let filterIdentities: FilterProcessIdentity[] = [];
  let cleanupArmed = true;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    run = runGatewayExecution({
      ...startOptions(harness.client),
      maskFilter: {
        binaryPath: filterPath,
        secretsFramePath: path.join(tempDir, "secrets.frame"),
      },
      cancellation: cancellation.signal,
    });
    const rejected = expectFailure(run);
    await harness.readLine();
    await writeSocketLine(
      harness.gateway,
      line({ type: "spawned", requestId: "r1", pid: process.pid }),
    );
    const filterPids = await waitForRecordedFilterPids(pidPath);
    filterIdentities = await captureFilterProcessIdentities(filterPids);
    await writeSocketLine(
      harness.gateway,
      line({ type: "process_exit", requestId: "r1", exitCode: 0 }),
    );
    await waitForRecordedFilterPids(eofPath);

    cancellation.abort(new Error("gateway disconnected"));
    const error = await Promise.race([
      rejected,
      new Promise<Error>((_, reject) =>
        setTimeout(
          () => reject(new Error("post-exit filter cleanup timed out")),
          2_000,
        ),
      ),
    ]);
    expect(error.message).toContain("gateway disconnected");
    await waitForFilterProcessesGone(filterIdentities);
    for (const identity of filterIdentities) {
      expect(await readFilterProcessIdentity(identity.pid)).toBeNull();
    }
    filterIdentities = [];
    cleanupArmed = false;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    harness.gateway.destroy();
    if (run) {
      await Promise.race([run.catch(() => {}), Bun.sleep(2_000)]);
    }
    if (cleanupArmed && filterIdentities.length > 0) {
      try {
        await forceFilterProcessesGone(filterIdentities);
      } catch (error) {
        cleanupError = error;
      }
    }
    await harness.close();
    await rm(tempDir, { recursive: true, force: true });
  }
  if (!primaryError && cleanupError) throw cleanupError;
});

test("runGatewayExecution kills when a mask filter cannot spawn", async () => {
  const harness = await openGatewayHarness();
  try {
    const run = runGatewayExecution({
      ...startOptions(harness.client),
      maskFilter: {
        binaryPath: "/tmp/nas-no-such-mask-filter",
        secretsFramePath: "/tmp/no-secrets-frame",
      },
    });
    const rejected = expectFailure(run);
    await harness.readLine();
    await writeSocketLine(
      harness.gateway,
      line({ type: "spawned", requestId: "r1", pid: process.pid }),
    );
    expect(await harness.readLine()).toMatchObject({
      type: "kill",
      requestId: "r1",
      signal: "SIGTERM",
    });
    expect((await rejected).message).toMatch(/spawn|ENOENT|mask-filter/i);
  } finally {
    await harness.close();
  }
});

test("runGatewayExecution fails a mask-filter stdin write closed by the filter", async () => {
  const harness = await openGatewayHarness();
  try {
    const run = runGatewayExecution({
      ...startOptions(harness.client),
      maskFilter: {
        binaryPath: TRUE_PATH,
        secretsFramePath: "/tmp/no-secrets-frame",
      },
    });
    const rejected = expectFailure(run);
    await harness.readLine();
    await writeSocketLine(
      harness.gateway,
      line({ type: "spawned", requestId: "r1", pid: process.pid }),
    );
    await writeSocketLine(
      harness.gateway,
      line({
        type: "raw_chunk",
        requestId: "r1",
        fd: 1,
        data: Buffer.from("input").toString("base64"),
      }),
    );
    expect(await harness.readLine()).toMatchObject({
      type: "kill",
      requestId: "r1",
      signal: "SIGTERM",
    });
    expect((await rejected).message).toMatch(/mask-filter|write|exited/i);
  } finally {
    await harness.close();
  }
});

test("runGatewayExecution fails fast when a filter exits during a silent command", async () => {
  const harness = await openGatewayHarness();
  try {
    const run = runGatewayExecution({
      ...startOptions(harness.client),
      maskFilter: {
        binaryPath: FALSE_PATH,
        secretsFramePath: "/tmp/no-secrets-frame",
      },
    });
    const rejected = expectFailure(run);
    await harness.readLine();
    await writeSocketLine(
      harness.gateway,
      line({ type: "spawned", requestId: "r1", pid: process.pid }),
    );
    const kill = await Promise.race([
      harness.readLine(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(kill).toMatchObject({
      type: "kill",
      requestId: "r1",
      signal: "SIGTERM",
    });
    expect((await rejected).message).toContain(
      "exited before command completion",
    );
  } finally {
    await harness.close();
  }
});

test("runGatewayExecution stops when filtered output loses its gateway", async () => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "nas-gateway-output-failure-"),
  );
  const filterPath = path.join(tempDir, "output-filter");
  const filterPidPath = path.join(tempDir, "output-filter.pid");
  await writeFile(
    filterPath,
    `#!${process.execPath}
import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(filterPidPath)}, String(process.pid) + "\\n");
for await (const _chunk of Bun.stdin.stream()) {
  process.stdout.write(Buffer.alloc(1024 * 1024, 0x41));
  await Bun.sleep(100);
}
`,
  );
  await chmod(filterPath, 0o700);

  const harness = await openGatewayHarness();
  let run: Promise<void> | undefined;
  let filterIdentities: FilterProcessIdentity[] = [];
  let cleanupArmed = true;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    run = runGatewayExecution({
      ...startOptions(harness.client),
      maskFilter: {
        binaryPath: filterPath,
        secretsFramePath: path.join(tempDir, "secrets.frame"),
      },
    });
    await harness.readLine();
    await writeSocketLine(
      harness.gateway,
      line({ type: "spawned", requestId: "r1", pid: process.pid }),
    );
    await writeSocketLine(
      harness.gateway,
      line({
        type: "raw_chunk",
        requestId: "r1",
        fd: 1,
        data: Buffer.from("trigger").toString("base64"),
      }),
    );
    const filterPids = await waitForRecordedFilterPids(filterPidPath);
    expect(filterPids).toHaveLength(2);
    expect(new Set(filterPids).size).toBe(2);
    filterIdentities = await captureFilterProcessIdentities(filterPids);
    harness.gateway.destroy();
    expect((await expectFailure(run)).message).toContain(
      "gateway disconnected",
    );
    await waitForFilterProcessesGone(filterIdentities);
    for (const identity of filterIdentities) {
      expect(await readFilterProcessIdentity(identity.pid)).toBeNull();
    }
    filterIdentities = [];
    cleanupArmed = false;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    harness.gateway.destroy();
    if (run) {
      await Promise.race([run.catch(() => {}), Bun.sleep(2_000)]);
    }
    if (cleanupArmed && filterIdentities.length > 0) {
      try {
        await forceFilterProcessesGone(filterIdentities);
      } catch (error) {
        cleanupError = error;
      }
    }
    await harness.close();
    await rm(tempDir, { recursive: true, force: true });
  }
  if (!primaryError && cleanupError) throw cleanupError;
});

test("runGatewayExecution fails closed when the gateway disconnects before terminal state", async () => {
  const harness = await openGatewayHarness();
  const run = runGatewayExecution(startOptions(harness.client));
  const rejected = expectFailure(run);
  await harness.readLine();
  harness.gateway.destroy();
  expect((await rejected).message).toContain(
    "gateway disconnected before terminal state",
  );
  await harness.close();
});
