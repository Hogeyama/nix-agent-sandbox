import { expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  ProtocolCommandError,
  runProtocolCommand,
} from "./protocol_command.ts";

function sink() {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  return { output, text: () => Buffer.concat(chunks).toString() };
}

test("protocol bytes survive chunking and EOF without diagnostics", async () => {
  const { output, text } = sink();
  const input = Readable.from([
    Buffer.from('{"id":1,'),
    Buffer.from('"method":"initialize"}\n'),
  ]);
  await runProtocolCommand(
    "bash",
    ["-c", "cat; echo bootstrap-diagnostic >&2"],
    { input, output },
  );
  expect(text()).toBe('{"id":1,"method":"initialize"}\n');
});

test("nonzero payload status is preserved", async () => {
  const { output } = sink();
  try {
    await runProtocolCommand("bash", ["-c", "exit 23"], {
      input: new PassThrough(),
      output,
    });
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolCommandError);
    expect((error as ProtocolCommandError).exitCode).toBe(23);
  }
});

test("EOF terminates a payload that ignores EOF and TERM", async () => {
  const { output } = sink();
  await runProtocolCommand(
    "bash",
    ["-c", "trap '' TERM; while :; do :; done"],
    { input: Readable.from([]), output, graceMs: 40 },
  );
});

test("abort waits for child termination and detaches stream listeners", async () => {
  const { output } = sink();
  const input = new PassThrough();
  const controller = new AbortController();
  const running = runProtocolCommand("bash", ["-c", "while :; do :; done"], {
    input,
    output,
    signal: controller.signal,
    graceMs: 40,
  });
  controller.abort();
  await expect(running).rejects.toThrow("interrupted");
  expect(input.listenerCount("end")).toBe(0);
  expect(output.listenerCount("close")).toBe(0);
});

test("closed protocol output terminates the payload", async () => {
  const { output } = sink();
  const running = runProtocolCommand("bash", ["-c", "while :; do :; done"], {
    input: new PassThrough(),
    output,
    graceMs: 40,
  });
  output.destroy();
  await expect(running).rejects.toThrow("disconnected");
});
