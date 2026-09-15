import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable, Writable } from "node:stream";
import { ProtocolCommandError } from "./protocol_command.ts";

const connectionContext = new AsyncLocalStorage<AcpConnection>();
export const ACP_PREPARATION_BUFFER_LIMIT = 1024 * 1024;

/** Read ahead only during preparation, with no transcript or unbounded spool. */
export class AcpConnection {
  readonly controller = new AbortController();
  private chunks: Buffer[] = [];
  private bytes = 0;
  private handedOff = false;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly limit: number;

  constructor(
    input: Readable = process.stdin,
    output: Writable = process.stdout,
    limit = ACP_PREPARATION_BUFFER_LIMIT,
  ) {
    this.input = input;
    this.output = output;
    this.limit = limit;
    input.on("data", this.buffer);
    input.once("end", this.eof);
    input.once("close", this.closedInput);
    input.once("error", this.inputError);
    output.once("close", this.closedOutput);
    output.on("error", this.outputError);
    if (input.readableEnded || input.destroyed) this.eof();
    if (output.destroyed) this.closedOutput();
  }

  private readonly buffer = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes + bytes.length > this.limit) {
      this.cancel(
        `ACP preparation input exceeds ${this.limit} bytes; wait for initialization before sending more input`,
      );
      return;
    }
    this.chunks.push(bytes);
    this.bytes += bytes.length;
  };
  private readonly eof = () =>
    this.cancel("ACP client closed stdin during preparation");
  private readonly closedInput = () =>
    this.cancel("ACP client disconnected during preparation");
  private readonly closedOutput = () =>
    this.cancel("ACP output disconnected during preparation");
  private readonly inputError = (error: Error) =>
    this.cancel(`ACP input failed during preparation: ${error.message}`);
  private readonly outputError = (error: Error) =>
    this.cancel(`ACP output failed during preparation: ${error.message}`);

  cancel(message = "ACP launch interrupted", exitCode = 1): void {
    this.controller.abort(new ProtocolCommandError(message, exitCode));
    if (!this.handedOff) this.input.pause();
  }

  /** Race slow read-only probes, so their completion cannot schedule the next phase. */
  async prepare<T>(operation: () => Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation(), interrupted]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** Transfer all buffered bytes once; from this point the transport owns EOF. */
  takeInput(): Readable {
    this.controller.signal.throwIfAborted();
    if (this.handedOff) throw new Error("ACP input already handed off");
    this.handedOff = true;
    this.detach();
    if (this.bytes) this.input.unshift(Buffer.concat(this.chunks, this.bytes));
    this.chunks = [];
    this.bytes = 0;
    return this.input;
  }

  takeStreams(): { input: Readable; output: Writable } {
    return { input: this.takeInput(), output: this.output };
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return connectionContext.run(this, operation);
  }

  private detach(): void {
    this.input.pause();
    this.input.off("data", this.buffer);
    this.input.off("end", this.eof);
    this.input.off("close", this.closedInput);
    this.input.off("error", this.inputError);
    this.output.off("close", this.closedOutput);
    this.output.off("error", this.outputError);
  }

  dispose(): void {
    if (!this.handedOff) this.detach();
    this.chunks = [];
    this.bytes = 0;
  }
}

export function takeAcpStreams():
  | { input: Readable; output: Writable }
  | undefined {
  return connectionContext.getStore()?.takeStreams();
}
