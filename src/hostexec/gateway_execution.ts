import type { Socket } from "node:net";
import type { MaskFilterConfig } from "./broker.ts";
import {
  type BrokerToGatewayMessage,
  type GatewayState,
  type GatewayToBrokerMessage,
  maxChunkBytes,
  maxControlBytes,
  parseBrokerToGatewayLine,
  parseGatewayToBrokerLine,
} from "./gateway_protocol.ts";

/**
 * The host-side half of one gateway request.
 *
 * The gateway owns the command process and sends raw output here. This
 * module owns only the two optional mask-filter processes and sends the
 * resulting masked bytes back over the same internal connection.
 */
export interface GatewayExecutionOptions {
  readonly socket: Socket;
  /** A reader that may already contain frames read with the execute request. */
  readonly reader?: GatewayLineReader;
  readonly requestId: string;
  readonly start: Extract<BrokerToGatewayMessage, { type: "start" }>;
  readonly maskFilter?: MaskFilterConfig;
  readonly onSpawned: (pid: number) => Promise<void>;
  /** Optional lifecycle hook used by broker diagnostics. */
  readonly onProcessExit?: (exitCode: number) => Promise<void>;
  /** Cancels terminal filter draining when the owning gateway disconnects. */
  readonly cancellation?: AbortSignal;
  /** Test instrumentation for the single aggregate filter-health subscription. */
  readonly onPipelineHealthSubscription?: () => void;
}

export interface GatewayLineReader {
  read(): Promise<Uint8Array | null>;
  close(): void;
  abort(error: Error): void;
}

export interface GatewayReadMonitorEvent {
  readonly line?: Uint8Array | null;
  readonly error?: Error;
}

export interface GatewayReadMonitor {
  startMonitor(onEvent: (event: GatewayReadMonitorEvent) => void): void;
}

type StreamFd = 1 | 2;
const FILTER_TERM_GRACE_MS = 250;
const FILTER_KILL_WAIT_MS = 1_000;

interface OutputPipeline {
  write(data: Uint8Array): Promise<void>;
  finish(): Promise<number>;
  stop(): Promise<void>;
  failure(): Promise<Error>;
}

class PipelineHealthMonitor {
  private failureError: Error | null = null;
  private closed = false;
  private task: Promise<void> | null = null;

  constructor(
    private readonly reader: GatewayLineReader,
    private readonly socket: Socket,
    private readonly onSubscription?: () => void,
  ) {}

  start(pipelines: Partial<Record<StreamFd, OutputPipeline>>): void {
    if (this.task) throw new Error("pipeline health monitor already started");
    this.onSubscription?.();
    const failures = ([1, 2] as const)
      .map((fd) => pipelines[fd]?.failure())
      .filter((failure): failure is Promise<Error> => failure !== undefined);
    if (failures.length === 0) return;
    this.task = Promise.race(failures)
      .then((error) => this.fail(error))
      .catch((error) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
    // The monitor converts both resolved and rejected health signals into a
    // stored failure and an aborted reader. Keep its task handled even when
    // execution is concurrently tearing down.
    void this.task.catch(() => {});
  }

  get failure(): Error | null {
    return this.failureError;
  }

  close(): void {
    this.closed = true;
  }

  private fail(error: Error): void {
    if (this.closed || this.failureError) return;
    this.failureError = error;
    try {
      this.reader.abort(error);
    } catch {
      // A custom reader may reject abort; close the transport as a last
      // resort so a pending read cannot remain live forever.
      this.socket.destroy();
    }
  }
}

/**
 * A persistent line reader is needed here instead of readJsonLine: the
 * gateway protocol's raw line parser must see the original bytes so it can
 * enforce the 4 MiB wire limit. It also retains extra lines when a socket
 * read contains more than one NDJSON frame.
 */
export class RawLineReader implements GatewayLineReader {
  private readonly chunks: Buffer[] = [];
  private chunkOffset = 0;
  private queuedBytes = 0;
  private ended = false;
  private failure: Error | null = null;
  private waiter: Promise<Uint8Array | null> | null = null;
  private resolveWaiter: ((line: Uint8Array | null) => void) | null = null;
  private rejectWaiter: ((error: Error) => void) | null = null;

  private readonly onData = (chunk: Buffer): void => {
    // Pull one bounded read at a time. A data event can still contain several
    // frames; retain that chunk without repeatedly copying the whole queue.
    this.socket.pause();
    this.chunks.push(chunk);
    this.queuedBytes += chunk.length;
    this.resolveAvailable();
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.resolveAvailable();
  };

  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  constructor(private readonly socket: Socket) {
    socket.pause();
    socket.on("data", this.onData);
    socket.once("end", this.onEnd);
    socket.once("close", this.onEnd);
    socket.once("error", this.onError);
  }

  async read(): Promise<Uint8Array | null> {
    const available = this.takeLine();
    if (available !== undefined) return available;
    this.assertPartialBounded();
    if (this.failure) throw this.failure;
    if (this.ended) {
      return this.takeRemainder();
    }
    if (this.waiter) return await this.waiter;
    this.waiter = new Promise<Uint8Array | null>((resolve, reject) => {
      this.resolveWaiter = resolve;
      this.rejectWaiter = reject;
    });
    this.socket.resume();
    try {
      return await this.waiter;
    } finally {
      this.waiter = null;
      this.resolveWaiter = null;
      this.rejectWaiter = null;
    }
  }

  close(): void {
    this.socket.pause();
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
  }

  abort(error: Error): void {
    this.fail(error);
  }

  private takeLine(): Uint8Array | undefined {
    const newline = this.findNewline();
    if (!newline) return undefined;

    let lineLength = 0;
    for (let index = 0; index <= newline.chunkIndex; index++) {
      const start = index === 0 ? this.chunkOffset : 0;
      const end =
        index === newline.chunkIndex
          ? newline.offset + 1
          : this.chunks[index].length;
      lineLength += end - start;
    }
    if (lineLength > maxControlBytes + 2) {
      this.fail(new Error(`control message exceeds ${maxControlBytes} bytes`));
      throw this.failure;
    }

    const segments: Buffer[] = [];
    let remaining = lineLength;
    for (let index = 0; remaining > 0; index++) {
      const chunk = this.chunks[index];
      const start = index === 0 ? this.chunkOffset : 0;
      const available = chunk.length - start;
      const length = Math.min(remaining, available);
      segments.push(chunk.subarray(start, start + length));
      remaining -= length;
    }
    this.consume(lineLength);
    return segments.length === 1
      ? segments[0]
      : Buffer.concat(segments, lineLength);
  }

  private resolveAvailable(): void {
    if (!this.resolveWaiter) return;
    try {
      const line = this.takeLine();
      if (line !== undefined) {
        const resolve = this.resolveWaiter;
        this.resolveWaiter = null;
        this.rejectWaiter = null;
        this.waiter = null;
        resolve(line);
        return;
      }
      this.assertPartialBounded();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (this.failure) {
      const reject = this.rejectWaiter;
      this.resolveWaiter = null;
      this.rejectWaiter = null;
      this.waiter = null;
      reject?.(this.failure);
      return;
    }
    if (this.ended) {
      const resolve = this.resolveWaiter;
      this.resolveWaiter = null;
      this.rejectWaiter = null;
      this.waiter = null;
      resolve(this.takeRemainder());
      return;
    }
    this.socket.resume();
  }

  private fail(error: Error): void {
    if (this.failure) {
      const reject = this.rejectWaiter;
      this.resolveWaiter = null;
      this.rejectWaiter = null;
      this.waiter = null;
      reject?.(this.failure);
      return;
    }
    this.failure = error;
    this.ended = true;
    this.socket.pause();
    this.resolveAvailable();
  }

  private findNewline(): { chunkIndex: number; offset: number } | undefined {
    for (let index = 0; index < this.chunks.length; index++) {
      const start = index === 0 ? this.chunkOffset : 0;
      const offset = this.chunks[index].indexOf(0x0a, start);
      if (offset >= 0) return { chunkIndex: index, offset };
    }
    return undefined;
  }

  private assertPartialBounded(): void {
    let partialBytes = 0;
    for (let index = this.chunks.length - 1; index >= 0; index--) {
      const chunk = this.chunks[index];
      const start = index === 0 ? this.chunkOffset : 0;
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= start) {
        partialBytes += chunk.length - newline - 1;
        break;
      }
      partialBytes += chunk.length - start;
    }
    if (partialBytes > maxControlBytes + 2) {
      this.fail(new Error(`control message exceeds ${maxControlBytes} bytes`));
      throw this.failure;
    }
  }

  private consume(length: number): void {
    let remaining = length;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.chunkOffset;
      const consumed = Math.min(remaining, available);
      this.chunkOffset += consumed;
      this.queuedBytes -= consumed;
      remaining -= consumed;
      if (this.chunkOffset === chunk.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
  }

  private takeRemainder(): Uint8Array | null {
    if (this.queuedBytes === 0) return null;
    const segments: Buffer[] = [];
    for (let index = 0; index < this.chunks.length; index++) {
      const start = index === 0 ? this.chunkOffset : 0;
      segments.push(this.chunks[index].subarray(start));
    }
    const remainder =
      segments.length === 1
        ? segments[0]
        : Buffer.concat(segments, this.queuedBytes);
    this.chunks.length = 0;
    this.chunkOffset = 0;
    this.queuedBytes = 0;
    return remainder;
  }
}

/**
 * Shares one pull reader between the approval lifecycle monitor and execution.
 * The monitor pulls at most one frame ahead; a pending approval therefore
 * cannot turn a slow policy decision into an unbounded input queue.
 */
export class BufferedGatewayLineReader
  implements GatewayLineReader, GatewayReadMonitor
{
  private queued = false;
  private queuedLine: Uint8Array | null = null;
  private inFlight: Promise<Uint8Array | null> | null = null;
  private monitorPromise: Promise<void> | null = null;
  private monitorSettled = false;
  private failure: Error | null = null;

  constructor(private readonly source: GatewayLineReader) {}

  async read(): Promise<Uint8Array | null> {
    if (this.queued) {
      this.queued = false;
      const line = this.queuedLine;
      this.queuedLine = null;
      return line;
    }
    if (this.failure) throw this.failure;
    if (this.monitorPromise && !this.monitorSettled) {
      await this.monitorPromise;
      return await this.read();
    }
    return await this.pull();
  }

  startMonitor(onEvent: (event: GatewayReadMonitorEvent) => void): void {
    if (this.monitorPromise) return;
    this.monitorPromise = this.pull()
      .then((line) => {
        this.queued = true;
        this.queuedLine = line;
        onEvent({ line });
      })
      .catch((error) => {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.failure = failure;
        onEvent({ error: failure });
      })
      .finally(() => {
        this.monitorSettled = true;
      });
    void this.monitorPromise.catch(() => {});
  }

  close(): void {
    if (this.monitorPromise && !this.monitorSettled) {
      this.source.abort(new Error("gateway reader closed"));
    }
    this.source.close();
  }

  abort(error: Error): void {
    this.failure = error;
    this.source.abort(error);
  }

  private async pull(): Promise<Uint8Array | null> {
    if (!this.inFlight) {
      this.inFlight = this.source.read();
    }
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}

class MessageWriter {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: Socket,
    private readonly state: () => GatewayState,
  ) {}

  send(message: BrokerToGatewayMessage): Promise<void> {
    const next = this.pending.then(async () => {
      const line = `${JSON.stringify(message)}\n`;
      // Validate the exact raw line before it reaches the socket. Besides
      // catching malformed internal messages, this keeps the 4 MiB guard on
      // both sides of the protocol boundary.
      parseBrokerToGatewayLine(line, this.state());
      await writeRawLine(this.socket, line);
    });
    this.pending = next;
    return next;
  }

  async drain(): Promise<void> {
    await this.pending;
  }
}

class IdentityPipeline implements OutputPipeline {
  private readonly noFailure = new Promise<Error>(() => {});

  constructor(private readonly send: (data: Uint8Array) => Promise<void>) {}

  async write(data: Uint8Array): Promise<void> {
    await this.send(data);
  }

  async finish(): Promise<number> {
    return 0;
  }

  async stop(): Promise<void> {}

  failure(): Promise<Error> {
    return this.noFailure;
  }
}

class MaskFilterPipeline implements OutputPipeline {
  private readonly process: ReturnType<typeof Bun.spawn>;
  private readonly outputTask: Promise<void>;
  private readonly failureSignal: Promise<Error>;
  private resolveFailure!: (error: Error) => void;
  private inputClosed = false;
  private finishing = false;
  private stopped = false;
  private failureError: unknown;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    config: MaskFilterConfig,
    private readonly send: (data: Uint8Array) => Promise<void>,
  ) {
    this.failureSignal = new Promise<Error>((resolve) => {
      this.resolveFailure = resolve;
    });
    this.process = Bun.spawn([config.binaryPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { NAS_MASK_SECRETS_FILE: config.secretsFramePath },
    });
    this.outputTask = this.pumpOutput().catch((error) => {
      this.reportFailure(error);
    });
    void this.process.exited.then((exitCode) => {
      if (!this.finishing && !this.stopped) {
        this.reportFailure(
          new Error(
            `nas-mask-filter exited before command completion with code ${exitCode}`,
          ),
        );
      }
    });
  }

  write(data: Uint8Array): Promise<void> {
    const next = this.writeTail.then(async () => {
      this.throwIfFailed();
      const stdin = this.process.stdin as import("bun").FileSink | null;
      if (!stdin) throw new Error("mask-filter stdin is unavailable");
      await Promise.resolve(stdin.write(data));
      this.throwIfFailed();
    });
    this.writeTail = next;
    return next;
  }

  async finish(): Promise<number> {
    this.finishing = true;
    await this.closeInput();
    const [exitCode] = await Promise.all([
      this.process.exited,
      this.outputTask,
    ]);
    this.throwIfFailed();
    return exitCode;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.process.kill("SIGTERM");
    } catch {
      // The filter may already have exited.
    }
    let exited = await waitForExit(this.process.exited, FILTER_TERM_GRACE_MS);
    if (!exited) {
      try {
        this.process.kill("SIGKILL");
      } catch {
        // The process may have exited between the grace deadline and SIGKILL.
      }
      exited = await waitForExit(this.process.exited, FILTER_KILL_WAIT_MS);
    }
    this.closeInputForStop();
    const settled = Promise.allSettled([this.process.exited, this.outputTask]);
    await waitForPromise(settled, FILTER_KILL_WAIT_MS);
    if (!exited) {
      this.reportFailure(
        new Error("nas-mask-filter did not exit after SIGKILL"),
      );
    }
  }

  private async closeInput(): Promise<void> {
    if (this.inputClosed) return;
    this.inputClosed = true;
    await this.writeTail;
    const stdin = this.process.stdin as import("bun").FileSink | null;
    if (stdin) await Promise.resolve(stdin.end());
  }

  private closeInputForStop(): void {
    if (this.inputClosed) return;
    this.inputClosed = true;
    void this.writeTail.catch(() => {});
    const stdin = this.process.stdin as import("bun").FileSink | null;
    try {
      stdin?.end();
    } catch {
      // The process is already being terminated.
    }
  }

  private async pumpOutput(): Promise<void> {
    const stdout = this.process.stdout as ReadableStream<Uint8Array> | null;
    if (!stdout) throw new Error("mask-filter stdout is unavailable");
    for await (const chunk of stdout) {
      for (let offset = 0; offset < chunk.length; offset += maxChunkBytes) {
        await this.send(chunk.subarray(offset, offset + maxChunkBytes));
      }
    }
  }

  private throwIfFailed(): void {
    if (this.failureError) {
      throw this.failureError instanceof Error
        ? this.failureError
        : new Error(String(this.failureError));
    }
  }

  failure(): Promise<Error> {
    return this.failureSignal;
  }

  private reportFailure(error: unknown): void {
    if (this.failureError) return;
    this.failureError = error;
    this.resolveFailure(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

export async function runGatewayExecution(
  options: GatewayExecutionOptions,
): Promise<void> {
  const reader = options.reader ?? new RawLineReader(options.socket);
  let state: GatewayState = "awaiting_decision";
  let spawned = false;
  let startSent = false;
  let commandMayExist = false;
  const pipelines: Partial<Record<StreamFd, OutputPipeline>> = {};
  const writer = new MessageWriter(options.socket, () => state);
  let healthMonitor: PipelineHealthMonitor | null = null;
  let terminalRead: Promise<never> | null = null;

  const sendMasked = (fd: StreamFd, data: Uint8Array): Promise<void> =>
    writer.send({
      type: "masked_chunk",
      requestId: options.requestId,
      fd,
      data: Buffer.from(data).toString("base64"),
    });

  try {
    await writer.send(options.start);
    startSent = true;
    commandMayExist = startSent;
    // `start` transitions the gateway from its decision state into the
    // running state. The gateway emits `spawned` only after it has actually
    // created the host process, but its protocol parser expects that message
    // in the running state.
    state = "running";

    while (true) {
      let line: Uint8Array | null;
      try {
        line = await reader.read();
      } catch (error) {
        throw healthMonitor?.failure ?? error;
      }
      if (healthMonitor?.failure) throw healthMonitor.failure;
      if (line === null) {
        throw new Error("gateway disconnected before terminal state");
      }

      let message: GatewayToBrokerMessage;
      try {
        message = parseGatewayToBrokerLine(line, state);
      } catch (error) {
        throw protocolError(error);
      }

      if (message.type === "execute") {
        throw new Error("gateway sent execute after start");
      }
      if (message.requestId !== options.requestId) {
        throw new Error(
          `gateway request ID mismatch: expected ${options.requestId}, got ${message.requestId}`,
        );
      }

      switch (message.type) {
        case "spawned": {
          if (spawned)
            throw new Error("gateway sent duplicate spawned message");
          spawned = true;
          state = "running";
          await options.onSpawned(message.pid);
          // Assign each pipeline as it is created. If the second filter
          // fails to spawn, the first one is still present in `pipelines` so
          // the outer failure path can stop it deterministically.
          pipelines[1] = options.maskFilter
            ? new MaskFilterPipeline(options.maskFilter, (data) =>
                sendMasked(1, data),
              )
            : new IdentityPipeline((data) => sendMasked(1, data));
          pipelines[2] = options.maskFilter
            ? new MaskFilterPipeline(options.maskFilter, (data) =>
                sendMasked(2, data),
              )
            : new IdentityPipeline((data) => sendMasked(2, data));
          healthMonitor = new PipelineHealthMonitor(
            reader,
            options.socket,
            options.onPipelineHealthSubscription,
          );
          healthMonitor.start(pipelines);
          break;
        }
        case "raw_chunk": {
          if (!spawned)
            throw new Error("gateway sent raw output before spawned");
          const pipeline = pipelines[message.fd];
          if (!pipeline)
            throw new Error(`missing mask pipeline for fd ${message.fd}`);
          await pipeline.write(Buffer.from(message.data, "base64"));
          break;
        }
        case "process_exit": {
          if (!spawned) throw new Error("gateway exited before spawned");
          // process_exit moves the gateway to awaiting_result before any
          // asynchronous work. A late filter or diagnostic failure must not
          // cause a kill that the gateway protocol only permits while running.
          state = "awaiting_result";
          // Keep one bounded read active while filters drain. RawLineReader
          // intentionally pauses its socket between reads, so without this a
          // peer close may not reach the lifecycle's cancellation signal.
          terminalRead = awaitGatewayTerminalRead(reader);
          void terminalRead.catch(() => {});
          // The gateway's process_exit is the authoritative point at which
          // command termination is known. Record it before draining filters
          // so diagnostics survive a masking failure or an already-gone PID.
          await raceWithCancellation(
            Promise.race([
              options.onProcessExit?.(message.exitCode) ?? Promise.resolve(),
              terminalRead,
            ]),
            options.cancellation,
          );
          const exits = await raceWithCancellation(
            Promise.race([
              Promise.all(
                ([1, 2] as const).map(async (fd) => {
                  const pipeline = pipelines[fd];
                  if (!pipeline)
                    throw new Error(`missing mask pipeline for fd ${fd}`);
                  return await pipeline.finish();
                }),
              ),
              terminalRead,
            ]),
            options.cancellation,
          );
          const failed = exits.find((exitCode) => exitCode !== 0);
          if (failed !== undefined) {
            throw new Error(
              `nas-mask-filter exited with code ${failed}; output may be incomplete`,
            );
          }
          await writer.drain();
          await writer.send({
            type: "result",
            requestId: options.requestId,
            exitCode: message.exitCode,
          });
          commandMayExist = false;
          state = "terminal";
          return;
        }
        case "cancelled":
          throw new Error(`gateway cancelled request: ${message.reason}`);
        case "transport_error":
          throw new Error(`gateway transport error: ${message.message}`);
      }
    }
  } catch (error) {
    if (startSent && commandMayExist && state === "running") {
      try {
        await writer.send({
          type: "kill",
          requestId: options.requestId,
          signal: "SIGTERM",
        });
      } catch {
        // The gateway may have disconnected at the same time. The caller
        // still receives the original failure and fails closed.
      }
    }
    await Promise.allSettled(
      ([1, 2] as const).map(async (fd) => await pipelines[fd]?.stop()),
    );
    throw error;
  } finally {
    if (terminalRead) {
      reader.abort(new Error("gateway execution reached terminal state"));
    }
    healthMonitor?.close();
    reader.close();
  }
}

function protocolError(error: unknown): Error {
  return new Error(
    `invalid gateway message: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function awaitGatewayTerminalRead(
  reader: GatewayLineReader,
): Promise<never> {
  const line = await reader.read();
  if (line === null) {
    throw new Error("gateway disconnected before terminal result");
  }
  throw new Error("gateway sent message after process_exit");
}

function raceWithCancellation<T>(
  promise: Promise<T>,
  cancellation: AbortSignal | undefined,
): Promise<T> {
  if (!cancellation) return promise;
  if (cancellation.aborted) {
    return Promise.reject(cancellationError(cancellation));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cancellation.removeEventListener("abort", onAbort);
      reject(cancellationError(cancellation));
    };
    cancellation.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cancellation.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        cancellation.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancellationError(cancellation: AbortSignal): Error {
  return cancellation.reason instanceof Error
    ? cancellation.reason
    : new Error("gateway execution cancelled");
}

async function waitForExit(
  exited: Promise<number>,
  timeoutMs: number,
): Promise<boolean> {
  return (
    (await waitForPromise(
      exited.then(() => true),
      timeoutMs,
    )) ?? false
  );
}

async function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function writeRawLine(socket: Socket, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(line, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
