import { spawn } from "node:child_process";
import { type Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";

export class ProtocolCommandError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "ProtocolCommandError";
    this.exitCode = exitCode;
  }
}

/** Byte-preserving transport. No parsing, logging, masking or transcript capture. */
export async function runProtocolCommand(
  command: string,
  args: readonly string[],
  options: {
    signal?: AbortSignal;
    input?: Readable;
    output?: Writable;
    graceMs?: number;
  } = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const graceMs = options.graceMs ?? 1000;
  if (options.signal?.aborted)
    throw new ProtocolCommandError("ACP launch interrupted", 130);
  const child = spawn(command, [...args], {
    stdio: ["pipe", "pipe", "inherit"],
    detached: true,
  });
  let forwarding = false;
  // The private bridge owns each write callback and final flush. Ending it
  // never ends the caller-owned stdout stream.
  const bridge = new Writable({
    write(chunk, _encoding, done) {
      forwarding = true;
      output.write(chunk, (error) => {
        forwarding = false;
        done(error);
      });
    },
  });
  let reason: "eof" | "disconnect" | "signal" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let streamError: Error | undefined;
  const eofSignals = new Set<NodeJS.Signals>();
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) {
        // A descendant can keep stdout open after the payload has already died.
        // Signalling that remaining group must not reclassify the payload crash.
        const payloadRunning =
          child.exitCode === null && child.signalCode === null;
        process.kill(-child.pid, signal);
        if (reason === "eof" && payloadRunning) eofSignals.add(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const kill = () => {
    signalGroup("SIGTERM");
    killTimer ??= setTimeout(() => {
      signalGroup("SIGKILL");
      if (forwarding) {
        streamError ??= new Error("ACP output did not flush before shutdown");
        disconnect();
      }
    }, graceMs);
  };
  const stop = (why: typeof reason) => {
    if (reason && (reason !== "eof" || why === "eof")) return;
    reason = why;
    input.unpipe(child.stdin);
    child.stdin.end();
    if (why === "eof") timer = setTimeout(kill, graceMs);
    else {
      bridge.destroy();
      child.stdout.unpipe(bridge);
      child.stdout.resume();
      // A cancelled destination cannot retain an outstanding write forever.
      // destroy also prevents a late callback error becoming an unhandled event.
      if (forwarding) output.destroy();
      kill();
    }
  };
  const eof = () => stop("eof");
  const disconnect = () => stop("disconnect");
  const abort = () => stop("signal");
  const inputError = (error: Error) => {
    streamError = error;
    disconnect();
  };
  const outputError = (error: Error) => {
    streamError = error;
    disconnect();
  };
  // A payload may close its input before exiting. Its exit status remains authoritative.
  const childInputError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
      streamError = error;
      disconnect();
    }
  };
  input.once("end", eof);
  input.once("error", inputError);
  output.once("close", disconnect);
  output.on("error", outputError);
  child.stdin.on("error", childInputError);
  options.signal?.addEventListener("abort", abort, { once: true });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const flushed = finished(bridge, { cleanup: true }).catch((error: Error) => {
    if (reason !== "signal" && reason !== "disconnect") {
      streamError ??= error;
      disconnect();
    }
  });
  child.stdout.pipe(bridge);
  input.pipe(child.stdin);
  if (input.readableEnded) eof();
  if (output.destroyed) disconnect();
  if (options.signal?.aborted) abort();
  try {
    const result = await completion;
    await flushed;
    if (reason === "signal")
      throw new ProtocolCommandError("ACP launch interrupted", 130);
    if (reason === "disconnect" || streamError)
      throw new ProtocolCommandError(
        `ACP output disconnected${streamError ? `: ${streamError.message}` : ""}`,
        1,
      );
    // Accept only the termination signal this transport sent for EOF. A crash
    // or external kill during the grace period is still a payload failure.
    if (reason === "eof" && result.signal && eofSignals.has(result.signal))
      return;
    if (result.code !== 0)
      throw new ProtocolCommandError(
        `${command} exited with ${result.signal ?? `code ${result.code}`}`,
        result.code ?? 1,
      );
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    input.unpipe(child.stdin);
    input.pause();
    child.stdout.unpipe(bridge);
    bridge.destroy();
    // Stream error/close notifications queued by the final write must run
    // while the transport still owns its output error handler.
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.off("end", eof);
    input.off("error", inputError);
    output.off("close", disconnect);
    output.off("error", outputError);
    options.signal?.removeEventListener("abort", abort);
  }
}
